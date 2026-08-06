# Plan — three fixes from session C0C21546 (2026-06-04)

**Read this entire file before starting. It is self-contained — no prior conversation needed.**

You are shipping three independent fixes that close the three bugs Derek surfaced in his 2026-06-04 05:37–05:41 UTC TestFlight smoke test (session `C0C21546-B138-4401-9536-3F6DDD14B458`, iOS build `394`). Each bug is reproduced empirically with CloudWatch evidence; each has an explicit code path and a recommended fix.

The three bugs are independent and can ship in any order or in parallel. Bug 1 + Bug 3 are backend-only and ship via CI to `main`. Bug 2 is iOS-only and lands on `main` but ships to inspectors only on the next TestFlight build. Backend changes are subject to the standing iOS-shared-backend rule (the `eicr-backend` task def is shared with iOS) — no contract changes required for any of these.

## Repos and working directories

- **Backend (Fix 1 + Fix 3):** `/Users/derekbeckley/Developer/EICR_Automation` — push to `main`, CI deploys to ECS in ~25 min.
- **iOS (Fix 2):** `/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified` — its own `.git`. Build locally with `xcodebuild -scheme CertMateUnified -destination 'platform=iOS Simulator,name=iPhone 17 Pro'`. TestFlight via `./deploy-testflight.sh` only when explicitly asked.

CI deploy log: `gh run watch <run-id> --exit-status`.

---

## Session evidence (source of truth)

CloudWatch query (eu-west-2):

```
fields @timestamp, @message
| filter sessionId = "C0C21546-B138-4401-9536-3F6DDD14B458"
| sort @timestamp asc
```

Time range: `2026-06-04T05:37:00Z` → `2026-06-04T05:42:00Z`. Backend log group: `/ecs/eicr/eicr-backend`.

Key inspector utterances and Sonnet responses:

| Turn | UTC | Inspector said (Deepgram) | What happened |
|---|---|---|---|
| 9 | 05:40:03 | "RCD triptan for **secus** 1 and 2 is 24 ms." | Two TTS played: "Circuit 1, RCD time 24" (05:40:04.986) then "Circuits 1, 2, RCD time 24" (05:40:05.179) ← **Bug 1** |
| 10 | 05:40:20 | "LCD tripped out for **circuits** 3 and 4 is 28 ms." | Canonical broadcast "Circuits 3, 4, RCD time 28" was DEDUPED at 05:40:22.012 (no TTS) ← **Bug 2** |
| 11 | 05:40:49 | "**Warming time** for circuits 2 and 3 is a." (garble) | Sonnet routed to `max_disconnect_time_s`, asked "What's the warming time value…?", user replied "Wiring type.", nothing written |
| 12 | 05:41:10 | "wiring type 4 circuits 2 and 3 is a" | Sonnet asked "What is the wiring type for circuits 2 and 3?", user replied "A.", **zero tool calls in continuation round** ← **Bug 3** |

Recording stopped at 05:41:20.657 — turn 12 had no chance of recovery.

---

## Fix 1 — Speculator broadcast race on Deepgram-garbled circuit nouns

### Symptom

Per-circuit speculator TTS ("Circuit 1, RCD time 24") plays inline at 05:40:04.986, ~190 ms before the canonical multi-circuit broadcast TTS ("Circuits 1, 2, RCD time 24") at 05:40:05.179. User hears two overlapping confirmations.

### Root cause

Two suppression layers in `src/extraction/loaded-barrel-speculator.js`:

1. **Pre-detect (lines 369-381)** — set by `runLiveMode` when `detectBroadcastIntent()` matches the inspector's transcript. The classifier lives in `src/extraction/dialogue-engine/parsers/circuit-range.js:158-163` and is regex-anchored on `\bcircuits?\s+\d+(?:\s*(?:,|and)\s*\d+){1,}\b`. **The garble "secus 1 and 2" does not contain the word "circuits" or "circuit" so the pre-detect misses entirely.**
2. **Reactive (lines 389-444)** — fires when the SECOND `record_reading` for the same `(field, value, boardId)` arrives, then `existing.controller.abort()`s the in-flight ElevenLabs synth. **By the time the abort runs, the WS `mid_stream_emit` envelope (built in `src/extraction/stage6-shadow-harness.js:517-548`) has already shipped to iOS, and iOS has already invoked `alertManager.speakBriefConfirmation` (DeepgramRecordingViewModel.swift:8562).** There is no retraction protocol; the audio cannot be recalled.

The race window in this session was ~128 ms (05:40:04.955 first `mid_stream_emit` → 05:40:05.083 `broadcast_detected`). Comments at speculator.js:364-368 already acknowledge this race exists.

### Fix

Widen `BROADCAST_LIST_RE` and `BROADCAST_RANGE_RE` in `src/extraction/dialogue-engine/parsers/circuit-range.js` to tolerate the single empirically-confirmed Deepgram garble of "circuits" from session C0C21546 (`secus`). Option D (broader plural-circuit heuristic without a noun anchor) remains rejected for this fix because it risks false positives on natural value dictation such as "1 to 6 megohms" and "1, 3 megohms". This is option **A** from investigation, scoped tightly: ONLY garbles observed in production logs go in the noun-anchor set — future garbles get added the same way as `secus` did, one production-log occurrence at a time.

**File:** `src/extraction/dialogue-engine/parsers/circuit-range.js`

**Change line 154 from:**
```js
const BROADCAST_RANGE_RE = /\bcircuits?\s+\d{1,3}\s*(?:to|through|thru|until|-|—|–)\s*\d{1,3}\b/i;
```
**to:**
```js
// Noun anchor tolerates Deepgram garbles of "circuits" observed in
// production transcripts. ONLY add a garble here when it appears in
// CloudWatch logs — speculative variants ("circus", "sirkets", etc.)
// stay out to avoid false-positives on natural designations. Wholesale
// fuzzy match also rejected — would false-positive on natural value
// dictation ("1 to 6 megohms").
// Evidence ledger:
//   - secus: session C0C21546 2026-06-04 turn-9 (this fix)
const CIRCUIT_NOUN_RE = '(?:circuits?|secus)';
const BROADCAST_RANGE_RE = new RegExp(
  `\\b${CIRCUIT_NOUN_RE}\\s+\\d{1,3}\\s*(?:to|through|thru|until|-|—|–)\\s*\\d{1,3}\\b`,
  'i'
);
```

**Change line 156 from:**
```js
const BROADCAST_LIST_RE = /\bcircuits?\s+\d{1,3}(?:\s*(?:,|and)\s*\d{1,3}){1,}\b/i;
```
**to:**
```js
const BROADCAST_LIST_RE = new RegExp(
  `\\b${CIRCUIT_NOUN_RE}\\s+\\d{1,3}(?:\\s*(?:,|and)\\s*\\d{1,3}){1,}\\b`,
  'i'
);
```

`BROADCAST_ALL_RE` at line 151 already covers "all circuits"-shaped phrases without a circuit-number list, so it doesn't need the noun-anchor widening.

### Tests

**Existing:** `src/__tests__/dialogue-engine-broadcast-prefilter.test.js` — already exercises `detectBroadcastIntent`.

**Add to that file** a new `describe` block titled `"Deepgram garbles of 'circuits' (session C0C21546 2026-06-04)"` with at least these positive cases (one per evidence-ledger entry — extend as the ledger grows). Each case is annotated with which regex it exercises so a future maintainer editing one regex doesn't accidentally orphan the other's coverage:

```js
// Evidence: session C0C21546 turn-9 2026-06-04
// LIST regex
expect(detectBroadcastIntent('RCD triptan for secus 1 and 2 is 24 ms')).toBe(true);
// LIST regex
expect(detectBroadcastIntent('Zs for secus 3 and 4 is 0.42')).toBe(true);
// RANGE regex
expect(detectBroadcastIntent('IR for secus 1 to 4 above 299')).toBe(true);
```

And these negative cases to confirm the noun anchor still rejects natural value dictation AND speculative garbles we have NOT yet observed:

```js
// Bare number-list MUST NOT match (no noun anchor)
expect(detectBroadcastIntent('1, 3 megohms')).toBe(false);
expect(detectBroadcastIntent('circuit 4 is 1 to 6 megohms')).toBe(false);
// Singular circuit + value MUST NOT match
expect(detectBroadcastIntent('circuit 5 is 0.42')).toBe(false);
// Speculative garbles NOT in the evidence ledger MUST NOT match — they
// stay out until a real production occurrence justifies adding them.
expect(detectBroadcastIntent('circus 1 and 2 is 24 ms')).toBe(false);
expect(detectBroadcastIntent('sirkets 1 and 2 is 24 ms')).toBe(false);
```

**Repro lock:** the exact production transcript MUST match. Add a separate test asserting:
```js
test('regression: session C0C21546 "secus 1 and 2" must classify as broadcast', () => {
  expect(detectBroadcastIntent('RCD triptan for secus 1 and 2 is 24 ms.')).toBe(true);
});
```

**Run:** `npm test -- dialogue-engine-broadcast-prefilter`. Additionally run `npm test -- loaded-barrel-speculator` and `npm test -- stage6-shadow-harness` to verify the existing `stage6-shadow-harness-broadcast-intent-wiring.test.js` post-detect wiring is unchanged AND the Fix-C off-enum round-1 synth gate (session F03B590C 2026-06-03 / `voice_latency.speculator_skipped_enum_field`) is not regressed — that gate fires in the same `_speculate` hot path as the noun-anchor widening; if any speculator test fails, the widening has cross-coupled with another speculator path and must be investigated before merge.

### Risk

- **False positives:** none expected. The single garble added (`secus`) is not a word that appears in EICR dictation as a circuit designation, test descriptor, or value — its only English usage is a rare Latin loanword in legal/academic contexts that an inspector would never speak during a test. If a future Deepgram garble emerges that we missed, the reactive bucket suppression still catches the SECOND circuit (just not the first) — same outcome as today, no worse.
- **Regression risk:** none — strictly additive to existing OR patterns. The pre-detect that's currently working stays working.
- **Evidence-ledger discipline:** the comment block at `CIRCUIT_NOUN_RE` enumerates which session each garble came from. New entries MUST cite a production session/turnId so the noun set doesn't drift into speculative variants.
- **Trace verification (pre-merge):** confirm the call sites of `detectBroadcastIntent` across `src/extraction/`. **Expected as of this plan: THREE call sites** — `stage6-shadow-harness.js:322` (writes `broadcastIntentByTurn`), `dialogue-engine/engine.js:92` (broadcast handler), `dialogue-engine/engine.js:1713` (script broadcast rejection). All three import the SAME function so the regex widening reaches all three automatically (no per-site change needed). The only one that's load-bearing for THIS fix is `stage6-shadow-harness.js:322` — it's the site that writes `broadcastIntentByTurn`, which the speculator reads at `loaded-barrel-speculator.js:371`. The other two are read-only consumers that benefit indirectly. If grep returns 4+ call sites, a NEW one has appeared since this plan and must be audited (does it also need to see the widened noun set?).

### Rollback

Revert the commit. Pre-fix behaviour returns: garbled circuit nouns fall through to the reactive bucket race.

### Commit message

```
fix(speculator): widen broadcast-intent noun anchor to Deepgram garbles of "circuits"

Session C0C21546 turn-9 (2026-06-04 05:40:03 UTC) — inspector said "RCD
triptan for circuits 1 and 2 is 24 ms". Deepgram garbled the noun to
"secus". detectBroadcastIntent's regex required \bcircuits?\b so the
pre-detect skipped the speculator's broadcast intent gate. The reactive
bucket then fired AFTER the per-circuit "Circuit 1, RCD time 24" TTS
had already shipped to iOS (~128 ms window between first mid_stream_emit
and broadcast_detected). User heard two overlapping confirmations.

Why noun-anchor expansion not fuzzy match: keeps the regex disjoint
from natural value dictation like "1 to 6 megohms" / "1, 3 megohms"
that's anchored on a bare number list with no noun. Adds only garbles
observed in production logs.

Why this specific set: secus only. It is the single garble observed in
production logs (session C0C21546 turn-9 2026-06-04 05:40:03 UTC).
Speculative phonetic neighbours (circus, sirkets, cercus, etc.) are
deliberately EXCLUDED — the evidence-ledger discipline at the
CIRCUIT_NOUN_RE comment requires a production session/turnId citation
before any new entry, and the negative tests in
dialogue-engine-broadcast-prefilter.test.js explicitly lock circus and
sirkets OUT. Add new entries one production occurrence at a time.
```

---

## Fix 2 — iOS dedupe-key collision silencing multi-circuit broadcast confirmations

### Symptom

Session C0C21546 turn-10 (05:40:20 UTC) — canonical broadcast confirmation "Circuits 3, 4, RCD time 28" was deduped on iOS at 05:40:22.012 because the dedupe key collided with turn-9's "Circuits 1, 2, RCD time 24" key. Both broadcasts share `dedupe_key: "rcd_time_ms_none"`. User heard NO confirmation for the second RCD trip-time reading.

The trap is field-wide: any field where the inspector dictates a broadcast value twice in a session (Zs across two rings, IR L-E across two banks, polarity across two groups, etc.) is silenced after the first occurrence.

### Root cause

**Server side, working correctly:** `src/extraction/stage6-event-bundler.js:367-379` builds broadcast confirmations with `circuit: null` (the singular field, deliberately nulled because the broadcast covers a circuit-bag) AND `circuits: [3, 4]` (the actual list of circuits covered):
```js
const entry = {
  text: grouped,
  expanded_text: expandForTTS(grouped),
  field: bucket.field,
  circuit: null,    // multi-circuit roll-up
  circuits,         // [3, 4]
};
```

**iOS, broken in two ways:**

1. `Sources/Services/ClaudeService.swift:291-336` — `ValueConfirmation` Codable struct does NOT decode the `circuits` field. The server is shipping it; iOS ignores it.

2. `Sources/Recording/DeepgramRecordingViewModel.swift:8498` (and `:4143`) — dedupe key formula collapses every broadcast to a single key:
   ```swift
   let dedupeKey = "\(conf.field ?? "unknown")_\(conf.circuit.map { String($0) } ?? "none")"
   ```
   For broadcasts `conf.circuit` is always nil → key is `"{field}_none"` for every broadcast on that field.

`confirmedFieldKeys: Set<String>` is reset only at recording-start (line 1130) — session-scoped. Once `rcd_time_ms_none` is in the set after turn 9, every later RCD-time broadcast is silenced for the rest of the recording.

### Fix

Two edits in two files.

**File 1:** `Sources/Services/ClaudeService.swift` (struct `ValueConfirmation` at line 291)

**Pre-check before editing:** confirm `ValueConfirmation` has BOTH a custom memberwise init (line 314-326) AND a custom `init(from decoder:)` (line 328-335). The Swift-synthesised init is shadowed by the custom one, so the property declaration alone is not enough — both inits must be updated. Verify both exist in the current source before applying any diff.

Add the `circuits` field. Insert IMMEDIATELY AFTER `let circuit: Int?` (line 303), BEFORE `let boardId: String?` (line 304) — keeps the singular/plural circuit fields grouped:

```swift
    /// Multi-circuit roll-up — the full list of circuits this confirmation
    /// covers when `text` is a grouped broadcast (e.g. "Circuits 1, 2, RCD
    /// time 24"). Backend bundler at stage6-event-bundler.js:378 populates
    /// this only when the bucket has 2+ circuit-level readings on the same
    /// (field, board_id, value). Single-circuit confirmations omit the
    /// field (decode as nil). decodeIfPresent below keeps this strict
    /// back-compat — pre-server-update payloads still decode cleanly.
    let circuits: [Int]?
```

In `CodingKeys` (line 306), insert `case circuits` BETWEEN `case circuit` and `case boardId` so enum order matches property order:
```swift
        case circuits
```

In the memberwise initialiser (line 314-326), add `circuits: [Int]? = nil` parameter (positioned after `circuit:`) and `self.circuits = circuits` assignment (positioned after `self.circuit = circuit`).

In the explicit `init(from decoder:)` (line 328-335), AFTER the `circuit` decode and BEFORE the `boardId` decode, add:
```swift
        circuits = try container.decodeIfPresent([Int].self, forKey: .circuits)
```

Note: the `let circuits: [Int]?` declaration from the property edit above MUST already be in place — the decoder line references it as the assignment target. Verify both edits in the same commit.

**Test-call compatibility note:** the new test files in `Tests/CertMateUnifiedTests/...` call `ValueConfirmation(text:, field:, circuit:, circuits:)` — Swift's argument-label matching skips defaulted parameters (`expandedText: nil`, `boardId: nil`) only when later labels match unambiguously. This is supported on Swift 5.5+ (Xcode 13+) and the project targets newer. If the test suite ever runs on an older toolchain, pass `expandedText: nil` and `boardId: nil` explicitly in the test calls.

**File 2:** `Sources/Recording/DeepgramRecordingViewModel.swift`

`DeepgramRecordingViewModel` is a `@MainActor final class`. Declare the helper as `nonisolated static func` (Swift `static` is implicitly internal — explicit `internal` keyword is optional). Place it at CLASS scope, NOT inside a method body and NOT inside an extension.

**Locate the insertion point by grep before editing by line number:**
```
grep -n "private var confirmedFieldKeys\|var confirmedFieldKeys" Sources/Recording/DeepgramRecordingViewModel.swift
```
Insert the helper IMMEDIATELY BELOW that property declaration (before the next blank line). Verify both the declaration line AND the reset call (`confirmedFieldKeys.removeAll()` near recording-start) live on the same class — the helper must sit on that class so `Self.buildConfirmationDedupeKey(conf)` resolves at the two call sites (lines 4143 and 8498).

```swift
/// Build the TTS confirmation dedupe key. Single-circuit → legacy
/// `"{field}_{circuit}"`; multi-circuit broadcast →
/// `"{field}_{sorted-circuits}_{djb2-text-hash}"`; degenerate →
/// `"{field}_none"`. SCOPING IS LOAD-BEARING — full rationale below.
///
/// (Full rationale)
///
///   - SINGLE-circuit confirmations (conf.circuit != nil) keep the
///     historical key shape "{field}_{circuit}" (e.g. "measured_zs_ohm_5").
///     This shape is shared with the correction-TTS dedupe at line 6845
///     which inserts keys of the form "{field}_{circuit}" into the same
///     confirmedFieldKeys Set; keeping single-circuit confirmation keys
///     identical preserves the existing correction↔confirmation
///     cross-dedupe (Bug A fix).
///
///   - MULTI-circuit broadcast confirmations (conf.circuit == nil AND
///     conf.circuits non-empty) use the new shape
///     "{field}_{sorted-joined-circuits}_{djb2-text-hash}" — this is the
///     ONLY path affected by the Bug 2 fix.
///
///   - DEGENERATE confirmations (both circuit and circuits nil) keep the
///     historical "{field}_none" shape — these are exceedingly rare
///     (board-level confirmations) and the legacy collision risk is
///     accepted, matching pre-fix behaviour.
///
/// Hash function for the broadcast branch: djb2 (deterministic across
/// process runs and platforms — String.hashValue is randomised per-
/// process per Swift SE-0206, which is fine for a session-scoped Set but
/// breaks exact-value test assertions and any future cross-run telemetry
/// that wants to pin a stable key).
///
/// Session C0C21546 2026-06-04 repro: turn-9 broadcast for circuits 1+2
/// inserted "rcd_time_ms_none", silencing turn-10's broadcast for
/// circuits 3+4. New broadcast key shape: "rcd_time_ms_1-2_<djb2>" /
/// "rcd_time_ms_3-4_<djb2>" — non-colliding.
nonisolated static func buildConfirmationDedupeKey(_ conf: ValueConfirmation) -> String {
    let field = conf.field ?? "unknown"
    if let c = conf.circuit {
        // Single-circuit: preserve historical "{field}_{circuit}" shape
        // so correction-TTS dedupe at line 6845 still cross-matches.
        return "\(field)_\(c)"
    }
    if let cs = conf.circuits, !cs.isEmpty {
        // Multi-circuit broadcast: new shape with djb2 text hash.
        let circuitKey = cs.sorted().map(String.init).joined(separator: "-")
        var hash: UInt64 = 5381
        for scalar in conf.text.unicodeScalars {
            hash = (hash &* 33) &+ UInt64(scalar.value)
        }
        return "\(field)_\(circuitKey)_\(hash)"
    }
    // Degenerate (no circuit information at all): historical "_none"
    // shape — matches pre-fix behaviour.
    return "\(field)_none"
}
```

**Locate the call sites by grep before editing by line number** (line drift between read and edit is plausible on a 9000+ line file):

```
grep -n 'conf.field ?? "unknown"' Sources/Recording/DeepgramRecordingViewModel.swift
```

Expect EXACTLY two matches — line 4143 (deferred flush path) and line 8498 (inline path). If grep returns three or more, the helper extraction has cross-coupled with another path and the replace must be re-audited. Do NOT use `_none` as the grep anchor — the correction-TTS path at line 6845 uses an identical `_none` suffix with `correctionCircuit` and `shortKey`, and would be a false positive.

Replace each of the two matched lines:
```swift
let dedupeKey = "\(conf.field ?? "unknown")_\(conf.circuit.map { String($0) } ?? "none")"
```
with:
```swift
let dedupeKey = Self.buildConfirmationDedupeKey(conf)
```

**Why the single-circuit branch keeps the old shape:** confirmations and corrections are both queued as `PendingConfirmation(confirmation: ValueConfirmation(...))` and drained by `flushPendingConfirmations` (which uses the line 4143 call site). If the helper changed the key shape for SINGLE-circuit confirmations, the correction-TTS dedupe at line 6845 (which inserts `"{field}_{circuit}"` into `confirmedFieldKeys`) would no longer cross-match a subsequent confirmation for the same field+circuit. That's the existing correction↔confirmation overlap protection from Bug A, and Fix 2 must NOT regress it.

**Do NOT modify** the correction-TTS dedupe path at `DeepgramRecordingViewModel.swift:6845-6852` (and the matching insert at line 6891). The helper's single-circuit branch above keeps the dedupe-key shape identical between the two call sites, so the existing cross-dedupe behaviour is preserved by construction.

### Tests

**Add iOS XCTest** at `Tests/CertMateUnifiedTests/Services/ValueConfirmationDecodeTests.swift` (new file — the SwiftPM test target path is `Tests/CertMateUnifiedTests/` per `CertMateUnified/Package.swift`; files at bare `Tests/` are NOT picked up by the test target):

```swift
import XCTest
@testable import CertMateUnified

final class ValueConfirmationDecodeTests: XCTestCase {
    func testDecodesCircuitsArrayFromBroadcastConfirmation() throws {
        let json = #"""
        {
          "text": "Circuits 1, 2, RCD time 24",
          "expanded_text": "Circuits 1, 2, R C D time 24",
          "field": "rcd_time_ms",
          "circuit": null,
          "circuits": [1, 2],
          "board_id": null
        }
        """#.data(using: .utf8)!
        let conf = try JSONDecoder().decode(ValueConfirmation.self, from: json)
        XCTAssertEqual(conf.field, "rcd_time_ms")
        XCTAssertNil(conf.circuit)
        XCTAssertEqual(conf.circuits, [1, 2])
    }

    func testBackCompatLegacyPayloadOmitsCircuits() throws {
        let json = #"""
        { "text": "Circuit 5, Zs 0.42", "field": "measured_zs_ohm", "circuit": 5 }
        """#.data(using: .utf8)!
        let conf = try JSONDecoder().decode(ValueConfirmation.self, from: json)
        XCTAssertEqual(conf.circuit, 5)
        XCTAssertNil(conf.circuits)
    }
}
```

**Add iOS XCTest** at `Tests/CertMateUnifiedTests/Recording/ConfirmationDedupeKeyTests.swift` (new file):

```swift
import XCTest
@testable import CertMateUnified

final class ConfirmationDedupeKeyTests: XCTestCase {
    func testTwoBroadcastsOnSameFieldHaveDistinctKeys() {
        let conf1 = ValueConfirmation(
            text: "Circuits 1, 2, RCD time 24",
            field: "rcd_time_ms", circuit: nil, circuits: [1, 2]
        )
        let conf2 = ValueConfirmation(
            text: "Circuits 3, 4, RCD time 28",
            field: "rcd_time_ms", circuit: nil, circuits: [3, 4]
        )
        XCTAssertNotEqual(
            DeepgramRecordingViewModel.buildConfirmationDedupeKey(conf1),
            DeepgramRecordingViewModel.buildConfirmationDedupeKey(conf2)
        )
    }

    func testTwoBroadcastsSameCircuitSetSameValueShareKey() {
        let conf1 = ValueConfirmation(
            text: "Circuits 1, 2, RCD time 24",
            field: "rcd_time_ms", circuit: nil, circuits: [1, 2]
        )
        let conf2 = ValueConfirmation(
            text: "Circuits 1, 2, RCD time 24",
            field: "rcd_time_ms", circuit: nil, circuits: [1, 2]
        )
        XCTAssertEqual(
            DeepgramRecordingViewModel.buildConfirmationDedupeKey(conf1),
            DeepgramRecordingViewModel.buildConfirmationDedupeKey(conf2)
        )
    }

    func testCircuitOrderIndependence() {
        let conf1 = ValueConfirmation(
            text: "x", field: "f", circuit: nil, circuits: [1, 2]
        )
        let conf2 = ValueConfirmation(
            text: "x", field: "f", circuit: nil, circuits: [2, 1]
        )
        XCTAssertEqual(
            DeepgramRecordingViewModel.buildConfirmationDedupeKey(conf1),
            DeepgramRecordingViewModel.buildConfirmationDedupeKey(conf2)
        )
    }

    func testSingleCircuitKeyShapePreservesLegacyShape() {
        // Single-circuit confirmations MUST keep the historical
        // "{field}_{circuit}" shape so the correction-TTS dedupe at
        // line 6845 (which inserts the same shape) still cross-matches.
        // This is the Bug A correction↔confirmation overlap; Fix 2 must
        // NOT regress it.
        let conf = ValueConfirmation(
            text: "Circuit 5, Zs 0.42",
            field: "measured_zs_ohm", circuit: 5, circuits: nil
        )
        XCTAssertEqual(
            DeepgramRecordingViewModel.buildConfirmationDedupeKey(conf),
            "measured_zs_ohm_5"
        )
    }

    func testMultiCircuitBroadcastKeyShape() {
        // Multi-circuit broadcasts use the new shape including the djb2
        // text hash. Pin the exact value — djb2 is deterministic, so a
        // hash-function regression fails this test loudly.
        let conf = ValueConfirmation(
            text: "Circuits 1, 2, RCD time 24",
            field: "rcd_time_ms", circuit: nil, circuits: [1, 2]
        )
        let expected = djb2("Circuits 1, 2, RCD time 24")
        XCTAssertEqual(
            DeepgramRecordingViewModel.buildConfirmationDedupeKey(conf),
            "rcd_time_ms_1-2_\(expected)"
        )
    }

    func testDegenerateKeyShapeMatchesPreFix() {
        // Confirmations with NO circuit information at all are rare and
        // intentionally keep the pre-fix "{field}_none" shape — Bug 2
        // does not promise to fix this case (no circuit data exists to
        // disambiguate with).
        let conf = ValueConfirmation(
            text: "x", field: "measured_zs_ohm", circuit: nil, circuits: nil
        )
        XCTAssertEqual(
            DeepgramRecordingViewModel.buildConfirmationDedupeKey(conf),
            "measured_zs_ohm_none"
        )
    }

    // Test-local djb2 reimplementation — mirrors the helper. If the
    // helper switches hash function, update both sites together.
    private func djb2(_ s: String) -> UInt64 {
        var hash: UInt64 = 5381
        for scalar in s.unicodeScalars {
            hash = (hash &* 33) &+ UInt64(scalar.value)
        }
        return hash
    }
}
```

**Run:** `xcodebuild test -scheme CertMateUnified -destination 'platform=iOS Simulator,name=iPhone 17 Pro'`.

### Risk

- **Hash choice (broadcast branch only):** djb2 (rather than `String.hashValue`) gives a deterministic, in-process-stable, cross-platform-stable 64-bit hash. `String.hashValue` is randomised per process run (Swift SE-0206) — fine for the session-scoped `Set` but breaks exact-value test assertions and would prevent any future cross-run telemetry from pinning a stable key. djb2 collision probability for two strings in a single session is vanishingly small (a 1-hour inspection sees ~200-500 distinct broadcast confirmation texts; birthday-bound collision risk ~10⁻¹²). Even in the impossible collision case, the worst outcome is silencing a broadcast confirmation that should have played — the existing bug today. djb2 is NOT applied to single-circuit confirmations; those keep the legacy `"{field}_{circuit}"` shape verbatim.
- **Back-compat:** the `circuits` field is decoded `decodeIfPresent`, so older backend payloads (pre-this-deploy) without `circuits` still decode. Single-circuit confirmation keys are byte-identical to pre-fix (preserves correction↔confirmation cross-dedupe from Bug A). Degenerate "no circuit info" confirmations keep the pre-fix `"{field}_none"` shape; only multi-circuit broadcasts gain the new shape.
- **Memory:** `confirmedFieldKeys` grows by one entry per unique broadcast text. In a 1-hour inspection with say 200 reading entries, the set holds ~200 strings of ~40 chars each → ~8 KB. Negligible.

### Rollback

Revert the iOS commit. Next TestFlight build returns to broken-but-known behaviour.

### Commit message (iOS)

```
fix(tts-dedup): include circuit-list + text hash in confirmation dedupe key

Session C0C21546 turn-10 (2026-06-04 05:40:20 UTC) — broadcast
confirmation "Circuits 3, 4, RCD time 28" was deduped at 05:40:22
because the dedupe key collided with turn-9's "Circuits 1, 2, RCD time
24". Both shipped with `circuit: null` so the key collapsed to
"rcd_time_ms_none". confirmedFieldKeys is session-scoped (cleared only
at recording-start) so any field where a broadcast value is dictated
twice in one session was silenced after the first.

Server bundler at stage6-event-bundler.js:378 already ships the actual
circuit list as `circuits: [3, 4]`. iOS ValueConfirmation didn't decode
the field. Now does (decodeIfPresent — strict back-compat).

Key shape (per-branch, scoped deliberately):
- Single-circuit (conf.circuit non-nil): preserves historical
  "{field}_{circuit}" (e.g. "measured_zs_ohm_5"). Identical to pre-fix.
  Preserves correction-TTS cross-dedupe at line 6845 by construction.
- Multi-circuit broadcast (conf.circuit nil, conf.circuits non-empty):
  new shape "{field}_{sorted-circuits-joined}_{djb2(text)}" — closes the
  Bug 2 collision.
- Degenerate (both nil): historical "{field}_none". Matches pre-fix.

Same broken formula appeared at two call sites (line 4143 flush path,
line 8498 inline path). Both routed through one
buildConfirmationDedupeKey helper for consistency. The correction-TTS
path at line 6845 is intentionally untouched and continues to use its
own `correctionDedupeKey` shape — which matches the new helper's
single-circuit branch so cross-dedupe still works.
```

---

## Fix 3 — Multi-circuit ask-answer auto-resolver

### Symptom

Session C0C21546 turn-12 (05:41:10 UTC): inspector said *"wiring type 4 circuits 2 and 3 is a"*. Sonnet asked `ask_user(question:"What is the wiring type for circuits 2 and 3?", context_field:"wiring_type", context_circuit:null)`. Inspector answered *"A."*. `stage6.ask_user` resolved at 05:41:19.328 with `answer_outcome:"answered", user_text:"A."`. Sonnet's continuation round (turn-12 round 1) emitted **zero tool calls** and ended (`tool_call_count_per_round:[1,0], terminal_reason:"end_turn"`). The wiring_type field was never written.

Recording stopped 1.3 s later (05:41:20.657) before any retry could happen.

### Root cause

Three converging gaps. **The structural one (Gap A) is necessary and sufficient to fix the bug**; the others reduce future incidence.

**Gap A — server-side enum/value auto-resolvers reject multi-circuit asks AND reject word-anchored select fields. Both gaps are load-bearing.**

`wiring_type` is `type:"select"` with `options:["A","B","C","D","E","F","G","H","O"]` (`config/field_schema.json:24-32`). The server-side enum resolver `resolveEnumAnswer` in `src/extraction/stage6-answer-resolver.js:1150` was originally shipped for digit-anchored BS-EN values (session DC946608, see comment at lines 1015-1041). It would auto-resolve "A." → "A" IF its two short-circuits could be bypassed:

Short-circuit 1 — single-circuit guard at line 1157:
```js
if (!contextField || contextCircuit === null || contextCircuit === undefined) {
  return { kind: 'no_value_context' };
}
```
Multi-circuit asks have `contextCircuit === null` (the schema at `stage6-tool-schemas.js:514` only allows `anyOf:[{integer},{null}]`), so this fires.

Short-circuit 2 — digit-only matcher gate roughly at lines 1206-1209:
```js
const anyDigitOption = matchableOptions.some((o) => /\d/.test(o));
if (!anyDigitOption) { return { kind: 'no_value_context' }; }
```
`wiring_type` options are pure letters, so even if Short-circuit 1 were widened, this gate would still bail. The whole matcher below it is digit-only (regex `/\d[\d-]*\d|\d+/`, `normaliseBsEnDigits`, Levenshtein on digit forms). The existing word-anchored test in `stage6-answer-resolver-enum.test.js:385-397` locks this behaviour explicitly with options `[A, B, F, AC]`.

`resolveValueAnswer` lines 607-615 has the same single-circuit guard PLUS sentinel rejections for `contextField === 'none'` and `contextField === 'observation_clarify'` (the latter two MUST be preserved — they protect non-real fields from numeric fan-out).

The dispatcher (`stage6-dispatcher-ask.js:731,817,912`) then falls to the legacy free-text body and returns `{answered:true, untrusted_user_text:"A."}` to Sonnet with no `auto_resolved` flag, no `match_status`, no hint.

**Closing only Short-circuit 1 leaves wiring_type still broken.** The fix MUST also add a word-anchored enum matcher path for select fields whose options have no digits.

**Gap B — prompt covers single-circuit + pending_write resolutions but not the plural / legacy-bare cases.**

`config/prompts/sonnet_agentic_system.md:177-189` documents BOTH the `pending_write + auto_resolved` flow (Sonnet told "Turn B: NO further tool calls") AND the single-circuit `value_resolved` / `enum_resolved` flow (same instruction). What it does NOT teach Sonnet is:
  - to supply `context_circuits` for PLURAL `missing_value` asks (the schema field doesn't exist today), AND
  - what to do on the legacy bare `{answered:true, untrusted_user_text}` body (no `auto_resolved`, no `match_status`) — Sonnet has no explicit instruction and defaults to text acknowledgement + `end_turn`.

The legacy-bare case is the same failure mode that triggered the value-resolver fix for session 08469BFC (see comment at `stage6-answer-resolver.js:546-557`): *"the model just verbally acknowledged and never emitted the write — six readings lost in a row."* That fix shipped for single-circuit digit-anchored asks only.

**Gap C — no "warming"→"wiring" garble correction.**

In turn 11, Deepgram garbled "wiring type" → "warming time" and Sonnet routed "warming time" → `max_disconnect_time_s` (the closest BS 7671 field by name). The session lost 20 seconds before turn 12 retried. `grep warming src/ config/` returns zero hits — no field-name-corrections entry and no Stage 6 prompt note exist for this garble. **Defer**; cost-of-fix is low but it's a quality-of-life improvement, not a structural bug.

### Fix

Structural fix for Gap A + prompt nudge for Gap B. Gap C deferred to a follow-up.

**Step 1 — extend the ask_user tool schema with an optional plural `context_circuits` AND refresh the surrounding descriptions.**

**File:** `src/extraction/stage6-tool-schemas.js`

1a. After the existing `context_circuit` property (line 514-518), add:

```js
    context_circuits: {
      anyOf: [
        {
          type: 'array',
          items: { type: 'integer', minimum: 1 },
          minItems: 2,
          uniqueItems: true,
        },
        { type: 'null' },
      ],
      description:
        'Optional: the list of circuit_refs this ask covers when it scopes to multiple circuits at once (e.g. "What is the wiring type for circuits 2 and 3?"). Use ONLY when 2+ circuits share a missing value; for single-circuit asks use context_circuit. When set, context_circuit MUST be null. When set, the server enum/value resolvers fan out the auto-resolved write across each circuit. minItems:2 enforces the "use plural for plural" rule; minimum:1 keeps circuit_ref 0 (a board-level sentinel per stage6-ask-gate-wrapper.js:123-130) out of the plural fan-out.',
    },
```

1b. Update the existing `context_field` description (around line 511) to acknowledge the new key shape used by ask-budget analytics. Find the phrase "Phase 5 ask-budget analytics bucket by this key + context_circuit" and replace with "Phase 5 ask-budget analytics bucket by this key + (context_circuit OR sorted context_circuits)".

1c. Update the existing `context_circuit` description (around line 517) to mirror the constraint: append "When context_circuits is set (multi-circuit ask), context_circuit MUST be null." to the existing description.

1d. Update the `ask_user` tool description (around line 472) to mention multi-circuit scope. Find the phrase "Do not ask if you have already asked about the same (context_field, context_circuit) pair in this session." and replace with "Do not ask if you have already asked about the same (context_field, context_circuit OR sorted context_circuits) scope in this session."

**Step 2 — widen the resolver guards AND add a word-anchored enum matcher.**

**File:** `src/extraction/stage6-answer-resolver.js`

2a. Update the `resolveEnumAnswer` function signature (around line 1150-1156) to accept `contextCircuits`:

```js
export function resolveEnumAnswer({
  userText,
  contextField,
  contextCircuit,
  contextCircuits,   // NEW
  sourceTurnId,
  fieldSchema,
}) {
```

2b. Replace the single-circuit guard at line 1157:
```js
  if (!contextField || contextCircuit === null || contextCircuit === undefined) {
    return { kind: 'no_value_context' };
  }
```
with the plural-aware guard (schema enforces `minItems:2` so the resolver requires `length >= 2` for the plural branch — keeps schema + resolver consistent; single-element arrays fall back to single-circuit semantics only via `contextCircuit`):

```js
  // Accept either single contextCircuit OR multi contextCircuits.
  // Multi asks (e.g. "wiring type for circuits 2 and 3") fan out the same
  // write across each circuit. Plural branch requires length >= 2 to match
  // the schema's minItems:2 (stage6-tool-schemas.js context_circuits).
  // Session C0C21546 2026-06-04 turn-12 repro: pre-fix, ask with
  // context_circuit:null + context_circuits:[2,3] hit the old guard and
  // user's "A." reply silently dropped (Sonnet emitted no record_reading).
  const circuitList =
    Array.isArray(contextCircuits) && contextCircuits.length >= 2
      ? contextCircuits
      : Number.isInteger(contextCircuit)
        ? [contextCircuit]
        : null;
  if (!contextField || !circuitList) {
    return { kind: 'no_value_context' };
  }
```

2c. Add a `buildWrites` helper (local to the function, scoped over `contextField`, `circuitList`, `sourceTurnId`) immediately AFTER the guard:

```js
  const buildWrites = (value, confidence) =>
    circuitList.map((circuit) => ({
      tool: 'record_reading',
      field: contextField,
      circuit,
      value,
      confidence,
      source_turn_id: sourceTurnId ?? null,
    }));
```

**Confidence is explicit — there is NO default.** Each existing `auto_resolve` branch hard-codes a specific confidence value today; using a helper default would silently regress those values. Audit before merging:
  - N/A path (around line 1196): currently 0.95 → call `buildWrites(value, 0.95)`.
  - Exact-digit-match path (around line 1241): currently 0.95 → call `buildWrites(opt, 0.95)`. The loop variable is `opt`, NOT `matchedOption` — that identifier is not in the file.
  - NEW word-anchored path (step 2d below): 0.9 is appropriate as a new threshold for a new code path.

Search `writes: [` inside `resolveEnumAnswer` to find every existing site; each must be converted to `buildWrites(value, confidence)` preserving its CURRENT confidence. Running the existing `stage6-answer-resolver-enum.test.js` BEFORE and AFTER the change with confidence assertions visible catches any drift.

2d. **NEW — word-anchored enum matcher** (closes the second short-circuit). Insert this block BEFORE the digit-only early return at lines 1206-1209 (find `const anyDigitOption = matchableOptions.some((o) => /\d/.test(o));`). The block runs ONLY when ALL options are digit-free — i.e. the field is a pure word/letter enum like `wiring_type` (`A-H,O`) or `rcd_type` (`AC, A, F, B, B+`). Mixed digit/letter option sets (e.g. a hypothetical voltage field with `["230","400","Other"]`) MUST fall through to the existing digit-anchored path unchanged.

**Scope note — `polarity_confirmed` is NOT covered by this block.** Its actual schema options are `['', 'OK', 'Y', 'N']` (`config/field_schema.json:244-248`) — a tri-state Y/N/OK select that already has dedicated coercion at `src/extraction/record-reading-coercion.js:75-87,140-150` mapping spoken `correct`/`pass`/`yes` → `Y`, `incorrect`/`fail`/`no` → `N`. The new word-anchored matcher MUST NOT pre-empt that coercion. Either (a) gate the matcher to fields explicitly whitelisted by this fix (`wiring_type`, `rcd_type`, `ocpd_type` if letter-coded) OR (b) invoke `coerceRecordReadingValue(contextField, text)` BEFORE the exact-token compare so spoken polarity replies resolve correctly. Option (a) is the minimum safe scope; option (b) is more comprehensive but expands the test surface.

Recommended: option (a) with an explicit allowlist (`WORD_ANCHORED_ENUM_FIELDS`) and a follow-up TODO to consider option (b) later:

```js
  // Word-anchored enum match: select fields whose options ALL contain no
  // digits AND that are explicitly enrolled in the word-anchored
  // matcher. The allowlist keeps polarity_confirmed (Y/N/OK with
  // coercion at record-reading-coercion.js) and any future implicit-
  // coercion field OUT of this path. To enrol a new field, add it
  // here and verify (a) the schema options are all letter-coded and
  // (b) no coercion table maps spoken aliases to canonical values.
  //
  // Predicate is `every` (NOT `some`) so the branch is mutually
  // exclusive with the existing `if (!anyDigitOption) return
  // no_value_context` guard.
  //
  // Matcher: normaliseEnumToken trims, lowercases, and strips ONLY
  // trailing sentence punctuation (.,!?) — preserves schema-significant
  // characters like '+' (rcd_type "B+") and internal '-' (rcd_type "A-S")
  // so "B+" cannot collide with "B".
  //
  // Session C0C21546 2026-06-04 turn-12 repro: wiring_type, user said
  // "A.", was silently dropped pre-fix.
  const WORD_ANCHORED_ENUM_FIELDS = new Set(['wiring_type', 'rcd_type', 'ocpd_type']);
  const allWordAnchoredOptions = matchableOptions.every((o) => !/\d/.test(String(o)));
  if (allWordAnchoredOptions && WORD_ANCHORED_ENUM_FIELDS.has(contextField)) {
    const normaliseEnumToken = (s) =>
      String(s ?? '').trim().toLowerCase().replace(/[.,!?]+$/g, '');
    const normalisedReply = normaliseEnumToken(text);
    const exact = matchableOptions.find(
      (o) => normaliseEnumToken(o) === normalisedReply
    );
    if (exact) {
      return {
        kind: 'auto_resolve',
        writes: buildWrites(exact, 0.9),
      };
    }
    // No match against a word-anchored option set → invalid_value with
    // the unfiltered field.options list (N/A included) so Sonnet sees
    // the same option-list shape it sees from the digit-anchored
    // invalid_value path below.
    return {
      kind: 'invalid_value',
      received: text,
      valid_options: field.options,
    };
  }
```

(The existing digit-only branches below this block stay as-is, but every `writes: [...]` array inside them MUST be replaced with `buildWrites(value, confidence)` per step 2c above — keeping each branch's current confidence verbatim, NOT the helper default.)

**Order-of-operations note:** the existing N/A short-circuit at lines 1183-1201 runs BEFORE this new block and gates on `field.options.includes('N/A')`. Two of the three allowlisted fields DO include N/A in their options (`rcd_type` and `ocpd_type` per `config/field_schema.json:164` and `:113`); `wiring_type` does NOT (line 27). So:
- For `rcd_type` and `ocpd_type` — a reply of "N/A" / "not applicable" is caught by the existing N/A short-circuit at confidence 0.95 and never reaches the word-anchored block.
- For `wiring_type` — the N/A short-circuit's `includes('N/A')` gate is false; a reply of "na" falls through to the word-anchored block and receives an `invalid_value` verdict with the full options list. That is the desired behaviour.

In both cases, `matchableOptions` (computed at line 1170: `field.options.filter((o) => o && o !== 'N/A')`) excludes the empty string AND `'N/A'` from the word-anchored matcher's option list — so even when N/A is in the field's options, it can never resolve via the word-anchored exact-match path. Defence in depth.

2e. Apply the equivalent guard + buildWrites changes to `resolveValueAnswer` (lines 604-615 + below):
   - Add `contextCircuits` parameter to its signature.
   - Replace lines 607-615 with a guard that BOTH preserves the sentinel rejections AND accepts `contextCircuits`:
```js
  if (!contextField || contextField === 'none' || contextField === 'observation_clarify') {
    return { kind: 'no_value_context' };
  }
  const circuitList =
    Array.isArray(contextCircuits) && contextCircuits.length >= 2
      ? contextCircuits
      : Number.isInteger(contextCircuit)
        ? [contextCircuit]
        : null;
  if (!circuitList) {
    return { kind: 'no_value_context' };
  }
```
   - Add the same `buildWrites` helper directly after the guard. Same explicit-confidence rule as 2c — NO default; every existing branch keeps its prior value. **Verified confidences as of this plan (file is the canonical source — if it diverges, the file wins, re-audit before changing):**
     - Discontinuous-phrase branch — writes array opens at line 637, `confidence: 0.9` on line 643 → `buildWrites(value, 0.9)`.
     - Corrected-value `"0.7 no 0.47"` branch — writes array opens at line 677, `confidence: 0.85` on line 683 → `buildWrites(value, 0.85)`.
     - Single-numeric branch — writes array opens at line 698, `confidence: 0.9` on line 704 → `buildWrites(value, 0.9)`.
   - Replace EVERY `writes: [...]` inside the function with `buildWrites(value, currentConfidence)` preserving the prior value. The discontinuous and corrected-value tests must continue to pass — fan-out preserves their existing behaviour for single-circuit asks.
   - **N/A handling is NOT in `resolveValueAnswer` today** — N/A is exclusively a `resolveEnumAnswer` concern (it requires schema-aware option-list awareness, and `resolveValueAnswer` has no `fieldSchema` parameter). Do NOT add an N/A test case to the `resolveValueAnswer` multi-circuit test bullet list; the test list below has been corrected to drop it.

**Step 3 — thread the new arg through the dispatcher (including the `buildResolvedBody` wrapper).**

**File:** `src/extraction/stage6-dispatcher-ask.js`

The two resolver calls (around lines 731 and 817) are NOT inside the top-level dispatch function — they live inside `buildResolvedBody(...)` (the helper around lines 594-605) which receives its arguments from the outer call site at lines 564-575. Inside that helper, `input` is NOT in scope; passing `input.context_circuits` directly produces a `ReferenceError`. Three coordinated edits:

3a. Caller — locate the `buildResolvedBody({` call at line 564. The existing object passes (verified against current file at lines 565-574): `outcome, pendingWrite, contextField, contextCircuit, session, autoResolveWrite, logger, sessionId, turnId, toolCallId`. Insert `contextCircuits: input.context_circuits ?? null,` IMMEDIATELY AFTER the `contextCircuit:` line (i.e. between current lines 568 and 569 — adjust to actual line position if a prior round 1-2 edit shifted line numbers):
```js
buildResolvedBody({
  outcome,
  pendingWrite,
  contextField,
  contextCircuit,
  contextCircuits: input.context_circuits ?? null,   // NEW — inserted here
  session,
  autoResolveWrite,
  logger,
  sessionId,
  turnId,
  toolCallId,
});
```

3b. `buildResolvedBody` signature (around lines 594-605) — add `contextCircuits` to the destructured parameter list:
```js
async function buildResolvedBody({
  outcome,
  contextField,
  contextCircuit,
  contextCircuits,   // NEW
  pendingWrite,
  // …existing args…
}) {
```

3c. Resolver invocations inside `buildResolvedBody`. There are THREE resolver call sites in this helper; only TWO take the new arg. Be explicit so the implementer doesn't accidentally add `contextCircuits` to the board resolver (which has no multi-circuit semantic — board lookups are single-board scoped):

  (i) `resolveBoardIdAnswer` at ~line 648 — does NOT take `contextCircuits`. Leave unchanged.

  (ii) `resolveEnumAnswer` at ~line 731 — add `contextCircuits` (the LOCAL variable, NOT `input.context_circuits`):
```js
const enumVerdict = resolveEnumAnswer({
  userText: outcome.user_text,
  contextField,
  contextCircuit,
  contextCircuits,                                  // NEW — local
  sourceTurnId: turnId,
  fieldSchema: FIELD_SCHEMA,
});
```

  (iii) `resolveValueAnswer` at ~line 817 — add `contextCircuits` (the LOCAL variable):
```js
const valueVerdict = resolveValueAnswer({
  userText: outcome.user_text,
  contextField,
  contextCircuit,
  contextCircuits,                                  // NEW — local
  sourceTurnId: turnId,
});
```

The `auto_resolved` and `resolved_writes` response bodies (around lines 782-788 and 867-873) automatically reflect the multi-write fan-out via the existing `dispatched.push(...)` loops — no further code change needed. The dispatcher already pushes each write as `{tool, field, circuit, value, ok}` per `stage6-dispatcher-ask.js:743-749`, so the iOS-facing payload includes the `ok:true` field per write.

3c-iv. **CloudWatch observability for multi-circuit fan-out.** In the existing `logger.info('stage6.ask_user_enum_auto_resolved', { … })` block (around lines 771-780) and the matching `stage6.ask_user_value_auto_resolved` block (around lines 856-865), add a new `circuits` field next to the existing `circuit: contextCircuit`. **Use the LOCAL `contextCircuits` variable (the destructured parameter from Step 3b), NOT `input.context_circuits` — `input` is out of scope inside `buildResolvedBody` per the warning in Step 3a:**

```js
circuits: contextCircuits ?? null,
```

Without this, the Field-test gate Bug 3 verification (which looks for `write_count: 2`) is the only signal of multi-circuit fan-out, and operators cannot see WHICH circuits were written without joining to the record_reading log lines. Adding `circuits` to the resolved-log row makes the fan-out queryable directly in CloudWatch.

**Step 4 — validator + ask-gate update.**

**File:** `src/extraction/stage6-dispatch-validation.js`

The ask validator currently inspects `context_field` + `context_circuit` (around line 449-499) with error codes `invalid_context_field`, `invalid_context_circuit`. Mirror that style. Insert the new check AFTER the `context_circuit` block (around line 496) and BEFORE the `expected_answer_shape` block (line 497):

```js
const ctxCircuits = input.context_circuits ?? null;
if (ctxCircuits !== null) {
  // Shape: must be a non-empty array of length >= 2, all entries unique
  // positive integers. minimum:1 keeps circuit_ref 0 (board-level
  // sentinel) out of the plural fan-out.
  if (
    !Array.isArray(ctxCircuits) ||
    ctxCircuits.length < 2 ||
    !ctxCircuits.every((n) => Number.isInteger(n) && n >= 1) ||
    new Set(ctxCircuits).size !== ctxCircuits.length
  ) {
    return { code: 'invalid_context_circuits', field: 'context_circuits' };
  }
  // XOR: schema description says context_circuit MUST be null when
  // context_circuits is set. Enforce in validator so Sonnet can't silently
  // ship both — resolver/ask-gate would otherwise prefer the plural with
  // no error surfaced.
  if (input.context_circuit !== null && input.context_circuit !== undefined) {
    return { code: 'context_circuit_conflict', field: 'context_circuits' };
  }
}
```

Error codes `invalid_context_circuits` (parallels `invalid_context_field` / `invalid_context_circuit`) and `context_circuit_conflict` (new). If the project has a validation-error enum (grep for `invalid_context_circuit` references — likely in a central enum file referenced by analytics), add BOTH codes to the same enum so the analyzer's bucket cardinality stays bounded.

**File:** `src/extraction/stage6-ask-gate-wrapper.js`

The ask-budget / debounce key is derived from `(context_field, context_circuit)` in `deriveAskKey` (around line 135-184). The current implementation has case/whitespace-insensitive sentinel handling for `context_field` (`null`, `undefined`, `'none'`, mixed-case `'NONE'`, padded sentinel forms) that landed in Plan 05-10 r4-#1 and Plan 05-11 r5-#1 — **that normalisation must be PRESERVED**. With multi-circuit asks added, every plural ask for the same field would otherwise collapse to `wiring_type:_`. Change ONLY the circuit-token computation:

```js
// Keep existing field normalisation (around lines 174-180) verbatim:
// case-insensitive 'none' sentinel handling, null/undefined collapse,
// whitespace trim — all unchanged.

// Replace the circuit-token line (line 182 — `const circuit =
// input?.context_circuit ?? '_';`) with the plural-aware version.
// Single-circuit ints (including 0 — see existing comment at
// lines 123-130 that intentionally keeps circuit:0 as a real bucket)
// preserve their token unchanged.
const circuitsArr = input?.context_circuits;
const circuitToken =
  Array.isArray(circuitsArr) && circuitsArr.length >= 2
    ? `[${[...circuitsArr].sort((a, b) => a - b).join('-')}]`
    : input?.context_circuit ?? '_';
return `${field}:${circuitToken}`;
```

Where `field` is the result of the existing normalisation block (do NOT re-derive it from `input.context_field` inline; use the variable the existing code already computes).

**Step 5 — prompt nudge.**

**File:** `config/prompts/sonnet_agentic_system.md`

Three coordinated edits (worked example + forward-pointing cross-ref + legacy-bare-body recovery instruction):

5a. Append a new worked example AFTER the existing Example 5b (around line 189). Call it Example 5c. Note the `ok:true` field on each resolved write — that mirrors the dispatcher's actual payload shape (`stage6-dispatcher-ask.js:743-749`):

```
Example 5c — Multi-circuit value or enum ask.
  User: "wiring type for circuits 2 and 3 is A" but you can't confidently parse the trailing single letter "A" as the value.
  Assistant Turn A: ask_user({
    question:"What is the wiring type for circuits 2 and 3?",
    reason:"missing_value",
    context_field:"wiring_type",
    context_circuit: null,
    context_circuits: [2, 3],
    expected_answer_shape:"free_text"
  })
  Inspector replies: "A."
  tool_result body: { answered:true, untrusted_user_text:"A.", auto_resolved:true, match_status:"enum_resolved", resolved_writes:[{tool:"record_reading", field:"wiring_type", circuit:2, value:"A", ok:true}, {tool:"record_reading", field:"wiring_type", circuit:3, value:"A", ok:true}] }
  Assistant Turn B: NO further tool calls. Server already wrote both circuits. End the turn.

  The same shape applies to value-resolved (numeric) plural asks — e.g. "Zs for circuits 5 and 6" → context_circuits:[5, 6], reply "0.42" auto-fans-out to both circuits.
```

5b. Add a forward-pointing cross-reference as a NEW bullet inserted BETWEEN current line 79 (the existing `Bare field, no value …` bullet) AND current line 80 (the blank line that separates ORPHANED VALUES from ASK_USER REASONS). The new bullet becomes the LAST entry in the ORPHANED VALUES list. Do NOT insert AT line 79 — that would corrupt the existing bullet text.

```
- When the ask scopes to multiple circuits at once, use `context_circuits: [N, M, …]` AND leave `context_circuit: null`. See Example 5c.
```

5c. Add a legacy-bare-body recovery instruction IMMEDIATELY AFTER Example 5b (BEFORE Example 5c above). Closes the long-standing Gap B failure mode where `{answered:true, untrusted_user_text:"…"}` arrives with no `auto_resolved` and no `match_status`, leaving Sonnet without explicit guidance:

```
Example 5b-recovery — When the tool_result is bare {answered:true, untrusted_user_text:"…"} with NO auto_resolved and NO match_status, the server's deterministic resolvers could not auto-write (e.g. the field is not a recognised select-enum, or the answer didn't match the expected shape, or pre-fix-deploy server). Treat the answer as quoted user content. If the original ask's context_field + (context_circuit OR context_circuits) is unambiguous, emit the appropriate record_reading / record_board_reading yourself with that value, the original circuit scope, and a fresh source_turn_id. If the field+circuit scope is ambiguous, emit ONE focused follow-up ask — do NOT silently end the turn.
```

5d. Add a CORE DIRECTIVE so the XOR constraint is hard-stated, not only implied by the schema description. In the CORE DIRECTIVES section (around line 31-35 of `sonnet_agentic_system.md`), append a new directive:

```
13. Multi-circuit asks use context_circuits (plural); set context_circuit to null. Never set BOTH on the same ask — the server rejects with `context_circuit_conflict` validation_error.
```

Renumber subsequent directives if any follow. This closes the soft-contract concern: without a directive-level rule, Sonnet might silently set both fields and the validator's new XOR check (Step 4) would fire on legitimate attempts.

### Tests

**Backend, add to** `src/__tests__/stage6-answer-resolver-enum.test.js`:

```js
describe('multi-circuit enum resolve (session C0C21546 2026-06-04)', () => {
  const WIRING_SCHEMA = {
    circuit_fields: {
      wiring_type: {
        label: 'Wiring Type',
        type: 'select',
        options: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'O'],
      },
    },
  };

  test('"A." answer with contextCircuits [2,3] fans out two writes', () => {
    const verdict = resolveEnumAnswer({
      userText: 'A.',
      contextField: 'wiring_type',
      contextCircuit: null,
      contextCircuits: [2, 3],
      sourceTurnId: 'turn-12',
      fieldSchema: WIRING_SCHEMA,
    });
    expect(verdict.kind).toBe('auto_resolve');
    expect(verdict.writes).toHaveLength(2);
    expect(verdict.writes.map((w) => w.circuit).sort()).toEqual([2, 3]);
    expect(verdict.writes.every((w) => w.field === 'wiring_type')).toBe(true);
    expect(verdict.writes.every((w) => w.value === 'A')).toBe(true);
  });

  test('falls through to single-circuit when only contextCircuit is set', () => {
    const verdict = resolveEnumAnswer({
      userText: 'B',
      contextField: 'wiring_type',
      contextCircuit: 5,
      contextCircuits: null,
      sourceTurnId: 'turn-x',
      fieldSchema: WIRING_SCHEMA,
    });
    expect(verdict.kind).toBe('auto_resolve');
    expect(verdict.writes).toHaveLength(1);
    expect(verdict.writes[0].circuit).toBe(5);
    expect(verdict.writes[0].value).toBe('B');
  });

  test('contextCircuits empty array falls back to no_value_context if no contextCircuit', () => {
    const verdict = resolveEnumAnswer({
      userText: 'A',
      contextField: 'wiring_type',
      contextCircuit: null,
      contextCircuits: [],
      sourceTurnId: 't',
      fieldSchema: WIRING_SCHEMA,
    });
    expect(verdict.kind).toBe('no_value_context');
  });

  test('invalid value with contextCircuits still escalates with did_you_mean', () => {
    const verdict = resolveEnumAnswer({
      userText: 'Z',
      contextField: 'wiring_type',
      contextCircuit: null,
      contextCircuits: [2, 3],
      sourceTurnId: 't',
      fieldSchema: WIRING_SCHEMA,
    });
    expect(['did_you_mean', 'invalid_value']).toContain(verdict.kind);
  });
});
```

**Backend, sync the test-fixture RCD_SCHEMA with the production schema BEFORE flipping the test.** The current fixture at `src/__tests__/stage6-answer-resolver-enum.test.js:30-60` defines `rcd_type` with the abbreviated options `['', 'AC', 'A', 'F', 'B', 'S', 'N/A']` (5 matchable values). Production `config/field_schema.json:164` has the fuller `['', 'AC', 'A', 'F', 'B', 'S', 'A-S', 'B-S', 'B+', 'N/A']` (8 matchable values). The new `B+`/`A-S`/`B-S` adjacent test cases below depend on the fuller fixture — replace the fixture's `rcd_type.options` array with the production list FIRST. This also closes future drift between fixture and production schema.

**Backend, FLIP the existing word-anchored test in** `src/__tests__/stage6-answer-resolver-enum.test.js:385-397`. The test currently exercises `rcd_type` with reply `"AC"` and asserts `no_value_context` with a comment saying word-anchored is out of scope. After Step 2d lands, that verdict flips. Update:
- Rename the test from `"field is select but options are word-anchored ... → no_value_context (out of current scope)"` to `"field is select but options are word-anchored (rcd_type AC|A|F|B|B+) → auto_resolve via word-anchored matcher"`.
- Change the assertion to `auto_resolve` with `writes:[{tool:"record_reading", field:"rcd_type", circuit:1, value:"AC", confidence:0.9, source_turn_id:null}]`.
- Delete the stale comment about word-anchored enums being future work.
- Add adjacent cases:
  - `"A."` → auto_resolve with value `"A"` (trailing punctuation stripped).
  - `"a"` → auto_resolve with value `"A"` (case-insensitive match).
  - `"B+"` → auto_resolve with value `"B+"` (the `+` is preserved by `normaliseEnumToken`; verifies it does NOT collide with `"B"`).
  - `"Z"` → `invalid_value` with `valid_options` = the unfiltered `field.options` list (includes N/A if present).
  - Add wiring_type variants (`'A.'`, `'a'`, `'Z'`) — same shape, different field/options.

**Backend, mixed-option-set regression guard** in the same test file: add a test for a hypothetical/real mixed digit+letter option set (e.g. craft a schema with `options: ["230","400","Other"]`) — `userText:"230"` MUST still resolve via the existing digit-anchored path, NOT via the new word-anchored block. This locks the predicate at Step 2d (`every` not `some`) so a future refactor can't accidentally invert it.

**Backend, add equivalent multi-circuit cases to** `src/__tests__/stage6-answer-resolver-value.test.js` exercising `resolveValueAnswer` with `contextCircuits`:
- numeric value `"0.42"` with `contextCircuits:[5,6]` → 2 writes at the function's current single-numeric confidence (0.9 at line 704).
- discontinuous reply `"infinity"` with `contextField:"ring_r1_ohm", contextCircuits:[3,4]` → 2 writes of ∞ at 0.9.
- corrected reply `"0.7 no 0.47"` with `contextCircuits:[3,4]` → 2 writes of `0.47` at 0.85 (line 683).
- (N/A multi-circuit case OMITTED — N/A handling lives in `resolveEnumAnswer`, not `resolveValueAnswer`; see Step 2e for the rationale.)

**Backend, dispatcher integration tests** at `src/__tests__/stage6-dispatcher-ask-enum.test.js`:
- The dispatcher threads `input.context_circuits` through `buildResolvedBody` into the resolver without `ReferenceError`. Asserts `context_circuits:[2,3]` reaches the resolver.
- The response body for a `wiring_type` multi-circuit ask carries `resolved_writes` with 2 entries, each shaped `{tool, field, circuit, value, ok:true}`.
- A malformed `context_circuits:[2]` (length-1) returns the validation-error envelope (`reason: 'validation_error'`, `code: 'invalid_context_circuits'`) — the validator rejects BEFORE reaching the resolver.

**Backend, resolver-direct unit tests** at `src/__tests__/stage6-answer-resolver-enum.test.js` (defence-in-depth — exercise resolver behaviour that the validator normally prevents from reaching it):
- `contextCircuits:[2]` with `contextCircuit:null` returns `no_value_context` (validates the `length >= 2` consistency with schema `minItems:2` — the validator normally rejects length-1, but the resolver must also defend).
- `contextCircuits:[2]` with `contextCircuit:5` falls back to single-circuit `[5]`.

**Backend, schema test:** add to `src/__tests__/stage6-tool-schemas.test.js` (or create) — assert `context_circuits` accepts `[2, 3]`, rejects `[2]` (minItems:2), rejects `[2, 2]` (uniqueItems).

**Backend, validation test:** add to `src/__tests__/stage6-dispatch-validation.test.js` (or `stage6-dispatch-validation-enum.test.js`):
- ask validator returns `{code: 'invalid_context_circuits', field: 'context_circuits'}` for malformed inputs: string, single-element `[2]`, duplicate values `[2,2]`, non-integer entries `["a",2]`, zero `[0,2]`, negative `[-1,2]`.
- ask validator accepts well-formed inputs: `null`, `undefined`, `[2,3]`, `[2,3,7]`.
- ask validator returns `{code: 'context_circuit_conflict', field: 'context_circuits'}` when BOTH `context_circuit: 5` AND `context_circuits: [2,3]` are set (XOR violation).

**Backend, resolver non-circuit-guard tests:** add to `src/__tests__/stage6-answer-resolver-enum.test.js` and `stage6-answer-resolver-value.test.js`:
- multi-circuit ask with `contextField:"earth_loop_impedance_ze"` (supply-characteristics) + `contextCircuits:[2,3]` → `no_value_context` (NON_CIRCUIT_CONTEXT_FIELDS guard).
- same for `contextField:"ze_at_db"` and one `installation_details` field.

**Backend, ask-gate test:** add to `src/__tests__/stage6-ask-gate-wrapper.test.js` (or wherever `deriveAskKey` tests live):
- Two consecutive plural asks `context_circuits:[2,3]` and `[4,5]` on the same field produce DISTINCT keys (`wiring_type:[2-3]` vs `wiring_type:[4-5]`).
- The existing field-normalisation invariants from Plan 05-10 r4-#1 / Plan 05-11 r5-#1 (case-insensitive `'none'` sentinel, whitespace-padded sentinel) are PRESERVED — assert with input `context_field:" none "` and `context_circuits:[2,3]` deriving to `'_:[2-3]'`.

**Run during iteration (fast feedback):** `npm test -- stage6-answer-resolver-enum stage6-answer-resolver-value stage6-dispatcher-ask-enum stage6-dispatch-validation stage6-ask-gate-wrapper stage6-tool-schemas`.

**Run pre-merge (full suite):** `npm test` — whole suite green; no count-pinning, CI is the gate.

### Risk

- **Sonnet behavioural change:** the prompt nudge teaches Sonnet to use the new field. If Sonnet ignores the prompt and continues to set `context_circuit: null` with no `context_circuits`, the OLD behaviour persists (resolver bails with `no_value_context`, dispatcher returns the legacy `{answered, untrusted_user_text}` body). So the worst case is "no change" — strictly additive.
- **Cross-prompt drift:** the other prompts (`sonnet_extraction_system.md`, `sonnet_text_system.md`, etc.) don't currently mention `context_circuits` either. Stage 6 agentic is the prompt that runs in production; the others are legacy / fallback. Don't update the legacy prompts in this fix — keeps blast radius tight.
- **Backward compat:** existing single-circuit asks unchanged. `contextCircuits` defaults to null/undefined → existing guard logic.
- **Word-anchored matcher scope:** the new branch handles non-digit enum options (wiring_type A-H/O, polarity_confirmed Correct/Incorrect, ocpd_type if it has letter codes, etc.). It runs only when `matchableOptions.some((o) => !/\d/.test(o))` — digit-bearing option sets (BS-EN, RCD rating) fall through to the existing digit path unchanged. Risk of regression on existing digit fields is therefore zero by construction.
- **Test coverage:** the new resolver path needs the multi-circuit, word-anchored, validator, and ask-gate tests above; without them a future refactor could regress.

**iOS parity (verified):** `CertMateUnified/Sources/Utilities/Constants.swift` already has `wiringTypes` (or equivalent) matching `["A","B","C","D","E","F","G","H","O"]` from `config/field_schema.json:24-32`. No iOS enum change is required for Bug 3. Grep `wiring_type` and `wiringTypes` in `CertMateUnified/Sources/Utilities/Constants.swift` before merge to re-confirm.

**Non-circuit field protection:** the `context_field` enum admits BOTH per-circuit and non-circuit fields. Non-circuit fields live in three schema sections: `board_fields`, `supply_characteristics_fields`, and `installation_details_fields` (see `CONTEXT_FIELD_ENUM` derivation at `src/extraction/stage6-tool-schemas.js:88-103` for the canonical union). Examples: `earth_loop_impedance_ze`, `ze_at_db`, `prospective_fault_current` live in `supply_characteristics_fields`; `address_postcode`, `client_name` live in `installation_details_fields`. The schema's `minItems:2` on `context_circuits` does NOT enforce that the field is per-circuit. If Sonnet sets `context_circuits:[2,3]` on a non-circuit field, `buildWrites` would emit `record_reading` writes against circuit-scope when the field is actually board/supply/installation-scope — wrong dispatch.

Add a defensive check at module load in both `resolveEnumAnswer` and `resolveValueAnswer` (declare once at the top of the file, use in both functions immediately after the `circuitList` guard):

```js
// Top-of-file (one declaration, both resolvers reference). Mirrors the
// createRequire boilerplate stage6-tool-schemas.js already uses at lines
// 33-42 (verified canonical pattern for this ES-modules codebase —
// import-assert / import-with both cause issues under the project's
// current Node + Jest setup).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const fieldSchema = require('../../config/field_schema.json');

// Mirror CONTEXT_FIELD_ENUM's non-circuit source set
// (stage6-tool-schemas.js:88-103). Computed once at module load;
// field_schema.json is the canonical source of truth. _ui_* meta keys
// are filtered out.
const NON_CIRCUIT_CONTEXT_FIELDS = new Set([
  ...Object.keys(fieldSchema.board_fields ?? {}),
  ...Object.keys(fieldSchema.supply_characteristics_fields ?? {}),
  ...Object.keys(fieldSchema.installation_details_fields ?? {}),
].filter((k) => !k.startsWith('_ui_')));

// Inside each resolver after the circuitList guard:
if (NON_CIRCUIT_CONTEXT_FIELDS.has(contextField) && circuitList.length > 1) {
  // Multi-circuit fan-out is meaningless for a board/supply/installation
  // field. Bail out — let the legacy free-text body handle it so Sonnet
  // can re-ask with the correct field semantics.
  return { kind: 'no_value_context' };
}
```

`stage6-answer-resolver.js` does NOT currently have `createRequire` boilerplate, so add it at the top of the file as shown. Add tests covering at least `ze_at_db` (supply), `earth_loop_impedance_ze` (supply), and one `installation_details` field — each multi-circuit ask MUST short-circuit to `no_value_context`.

**Multi-write fan-out on iOS:** the dispatcher's `resolved_writes` response carries TWO `record_reading` entries on the same WS extraction broadcast. iOS already handles multi-entry extraction responses via the existing `ExtractedReading[]` decode path in `ServerWebSocketService.swift` (the bundler routinely ships multi-circuit broadcasts today). No iOS change is required to consume the fan-out; verify by running the existing `Tests/CertMateUnifiedTests/Services/ServerWebSocketServiceTests.swift` suite (or equivalent) after Fix 3 deploys.

### Rollback

Revert the six files: `stage6-tool-schemas.js`, `stage6-answer-resolver.js`, `stage6-dispatcher-ask.js`, `stage6-dispatch-validation.js`, `stage6-ask-gate-wrapper.js`, `config/prompts/sonnet_agentic_system.md`. Sonnet sees the older schema; new tool calls won't include `context_circuits`. Old behaviour resumes immediately on the next deploy (the schema diff is observed by the model on every API call — no per-session state to worry about).

### Commit message

```
fix(stage6): multi-circuit ask_user answer auto-resolver

Session C0C21546 turn-12 (2026-06-04 05:41:10 UTC) — Sonnet asked
"What is the wiring type for circuits 2 and 3?" with context_field:
"wiring_type", context_circuit: null. Inspector answered "A." (a valid
wiring_type enum option). The continuation round emitted zero
record_reading calls and ended; wiring_type was never written.

Root cause: resolveEnumAnswer / resolveValueAnswer guarded on
contextCircuit being a single int. Multi-circuit asks (Sonnet's
schema allows only a single int or null, so plural → null) bailed
with no_value_context. The dispatcher then returned the legacy
{answered:true, untrusted_user_text:"A."} body. Sonnet's prompt only
documents the auto_resolved + escalated cases — the bare answer has
no explicit "now write it" instruction, so Sonnet defaults to text
acknowledgement + end_turn. Same failure mode as session 08469BFC
fixed previously for single-circuit asks.

Fix:
- Add ask_user.context_circuits (array of int, minItems:2, uniqueItems,
  optional).
- resolveEnumAnswer gains a word-anchored matcher path for select fields
  with no digit-bearing options (wiring_type [A-H,O],
  polarity_confirmed, etc.). Existing digit-anchored path unchanged.
- resolveEnumAnswer / resolveValueAnswer accept contextCircuits and fan
  the resolved write out across each circuit in the list via a local
  buildWrites helper. Single-circuit semantics unchanged.
- Dispatcher threads context_circuits through buildResolvedBody's
  parameter list (input is not in scope inside the helper — direct
  reference would ReferenceError).
- Validator (stage6-dispatch-validation.js) accepts/rejects
  context_circuits per the schema.
- Ask-gate (stage6-ask-gate-wrapper.js) folds context_circuits into the
  dedupe key so plural asks for different circuit sets on the same
  field don't collapse.
- Prompt: Example 5c added at sonnet_agentic_system.md teaching Sonnet
  to use the plural field when the ask scopes to 2+ circuits.

Single-circuit semantics unchanged. If Sonnet ignores the new field,
behaviour is identical to today (resolver bails, legacy body
returned) — strictly additive.

Test coverage: word-anchored enum tests for wiring_type "A."/"a"/"Z"
and rcd_type "AC"/"B+"/"B" (covers '+' preservation), mixed-option-set
regression guard, multi-circuit enum fan-out, N/A multi-circuit
(enum-only), multi-circuit value resolves
(numeric/discontinuous/corrected — N/A is enum-only), dispatcher
threading via buildResolvedBody, single-element resolver fallback,
schema validation (minItems:2/uniqueItems/minimum:1), validator
rejection of malformed context_circuits, XOR violation rejection
(context_circuit + context_circuits both set), non-circuit field
guard for ze_at_db / earth_loop_impedance_ze, and ask-gate dedupe-key
distinctness across plural asks on the same field.
```

---

## Rollout order

The three fixes are independent. Recommended sequence:

1. **Fix 1 (backend)** — push to `main` first. Smallest blast radius. CI deploys in ~25 min. No iOS dependency.
2. **Fix 3 (backend)** — push to `main` after Fix 1 lands (or in parallel — they don't conflict). CI deploys in ~25 min. No iOS dependency.
3. **Fix 2 (iOS)** — commit to `main` of the iOS repo. Does NOT ship to inspectors until Derek runs `./deploy-testflight.sh`. Don't deploy TestFlight as part of this fix work; wait for explicit instruction.

Each fix gets its own commit (don't bundle). Commit messages above.

After each backend deploy, verify with:
```
gh run watch <run-id> --exit-status
aws logs tail /ecs/eicr/eicr-backend --region eu-west-2 --since 5m \
  | grep -E "loaded_barrel_broadcast_detected|ask_user_enum_auto_resolved"
```

## Field-test gate (manual repro)

After all three are in production AND iOS is on TestFlight:

1. **Bug 1 verification:** unit-test green (`dialogue-engine-broadcast-prefilter.test.js` regression case for `secus 1 and 2`) is the primary signal — field-test repro is unreliable because Deepgram's STT output for a deliberately mispronounced "circuits" is non-deterministic, and we deliberately did NOT add speculative garbles to the regex. Post-deploy, query CloudWatch for `loaded_barrel_broadcast_detected` and `loaded_barrel_skipped_broadcast_intent` events on real broadcast utterances over the next week; if a NEW garble shows up in production logs that the noun-anchor missed, add it to the evidence ledger (`CIRCUIT_NOUN_RE` comment block in `circuit-range.js`).
2. **Bug 2 repro:** in the same recording, dictate the same field for a different pair of circuits (e.g. "RCD trip time for circuits 3 and 4 is 28 ms"). Expect a SECOND TTS confirmation ("Circuits 3, 4, RCD time 28"), not silence.
3. **Bug 3 repro:** dictate a multi-circuit wiring-type-like value with an ambiguous trailing letter ("wiring type for circuits 2 and 3 is A"). When Sonnet asks, answer with the single letter. Expect both circuits' wiring_type column to populate. Verify in CloudWatch with a query like:
   ```
   fields @timestamp, @message
   | filter sessionId = "<new-session-id>"
   | filter @message like /stage6.ask_user_enum_auto_resolved/
   ```
   Expect a row with `write_count: 2`.

If any gate fails, do not close the bug. Investigate the specific Failure mode in CloudWatch before retrying.

## Out of scope (deferred follow-ups)

- **Gap C — warming/wiring garble correction.** Add an entry to `field-name-corrections.js` or a stage6 prompt note. Low priority; the multi-circuit resolver fix above structurally handles the case once Sonnet eventually asks the right field.
- **Speculator iOS-side cancel protocol** (option C from investigation). A more robust fix for Bug 1 across any unanticipated garble. Requires both backend protocol addition and iOS audio-queue intercept. Defer until garble-list maintenance proves too painful.
- **Speculator pre-text delay** (option B from investigation). Trades latency for safety. Recent latency project (commit `8844391` 2026-06-04) is the active priority; defer.

## CloudWatch queries you'll need

Reference query for any post-deploy verification:

```
fields @timestamp, @message
| filter sessionId = "<sid>"
| filter @message like /loaded_barrel|broadcast_intent|confirmation_tts_decision|ask_user_enum|ask_user_value/
| sort @timestamp asc
| limit 100
```

Backend log group: `/ecs/eicr/eicr-backend`, region `eu-west-2`.

## Files touched (summary)

**Backend (Fix 1):**
- `src/extraction/dialogue-engine/parsers/circuit-range.js`
- `src/__tests__/dialogue-engine-broadcast-prefilter.test.js`

**Backend (Fix 3):**
- `src/extraction/stage6-tool-schemas.js` — add `context_circuits` to ask_user schema
- `src/extraction/stage6-answer-resolver.js` — multi-circuit + word-anchored matcher
- `src/extraction/stage6-dispatcher-ask.js` — thread context_circuits through buildResolvedBody
- `src/extraction/stage6-dispatch-validation.js` — validate context_circuits shape
- `src/extraction/stage6-ask-gate-wrapper.js` — include context_circuits in deriveAskKey
- `config/prompts/sonnet_agentic_system.md` — Example 5c + orphaned-values cross-ref
- `src/__tests__/stage6-answer-resolver-enum.test.js` — word-anchored + multi-circuit cases (update existing line 385-397 lock)
- `src/__tests__/stage6-answer-resolver-value.test.js` — multi-circuit fan-out cases
- `src/__tests__/stage6-dispatcher-ask-enum.test.js` — buildResolvedBody threading test
- `src/__tests__/stage6-dispatch-validation.test.js` (or `-enum.test.js`) — validator rejection cases
- `src/__tests__/stage6-ask-gate-wrapper.test.js` — plural-ask dedupe-key distinctness
- `src/__tests__/stage6-tool-schemas.test.js` (or create) — schema validation cases

**iOS (Fix 2):**
- `Sources/Services/ClaudeService.swift` — add `circuits: [Int]?` to ValueConfirmation
- `Sources/Recording/DeepgramRecordingViewModel.swift` — `buildConfirmationDedupeKey` helper + replace at lines 4143 and 8498 (do NOT touch line 6845 correction-TTS path)
- `Tests/CertMateUnifiedTests/Services/ValueConfirmationDecodeTests.swift` (new)
- `Tests/CertMateUnifiedTests/Recording/ConfirmationDedupeKeyTests.swift` (new)

**iOS (Fix 3 pre-merge check, no edit expected):**
- `CertMateUnified/Sources/Utilities/Constants.swift` — grep `wiringTypes` to confirm `["A","B","C","D","E","F","G","H","O"]` parity with `config/field_schema.json:24-32`. Expected: no change required.

Net diff: roughly +650 / -15 lines (mostly tests; Fix 3 now covers two more backend files than the initial scope identified).
