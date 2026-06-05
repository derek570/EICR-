# Regex tier + 3-tier field priority — implementation plan

> **Status:** plan only. No code shipped yet. Authored 2026-04-25 after the
> Wave-B audit closed every other Phase 6 P0 (`web/audit/INDEX.md` open
> follow-ups list).
>
> **Audit reference:** Phase 6 — "No regex layer", "2-tier field priority
> instead of 3-tier", "iOS uses `TranscriptFieldMatcher` for instant ~40 ms
> regex extraction before Sonnet (~1-2 s) lands". These two items are
> coupled — you can't have 3-tier priority without a regex layer to be the
> third tier.
>
> **iOS source:**
>   - `CertMateUnified/Sources/Recording/TranscriptFieldMatcher.swift` (2,128 lines)
>   - `CertMateUnified/Sources/Recording/TranscriptProcessor.swift` (315 lines)
>   - `CertMateUnified/Sources/Recording/NumberNormaliser.swift`
>   - `CertMateUnified/Sources/Resources/default_config.json#regex_patterns`
>   - `CertMateUnified/Sources/Recording/DeepgramRecordingViewModel.swift`
>     `applyRegexValue` / `applySonnetValue` (the priority rules)
>
> **Backend reference:** `src/extraction/sonnet-stream.js` already accepts
> regex-hint metadata bundled with `transcript` messages. iOS has been
> sending them since 2026-02-26 (see `buildRegexSummary` on iOS); the
> server uses them to tell Sonnet "this field already has a regex
> answer — only overwrite if you're sure". Web doesn't currently send
> any. **No backend changes required by this plan** — iOS-shared
> contract; we only need to start emitting on web.

## What "done" looks like

A web recording session ends with **the same `fieldSources` distribution
as iOS for the same audio** — roughly:
- ~30-40 % regex-set fields (the high-confidence numeric/categorical readings)
- ~50-60 % Sonnet-set fields (the disambiguating + low-confidence + structured)
- pre-existing CCU/manual fields untouched unless Sonnet has high-confidence disagreement

Inspector-visible improvements:
- Field-fill latency on numeric readings drops from ~1-2 s (current Sonnet-only) to ~40 ms.
- The LiveFillView flash-yellow → flash-blue transition we already render becomes
  visually meaningful: yellow = regex landed instant, blue = Sonnet refined to
  the same/better value, red flash = Sonnet disagreed with regex.
- Sonnet's per-turn cost drops because it skips fields the regex already filled
  with high confidence (server gate honours the hint metadata).

## Architecture diagram

```
                  iOS (canon)                                     Web (target)
                  ──────────────                                  ──────────────

   16 kHz PCM                                                     16 kHz PCM
       │                                                              │
       ▼                                                              ▼
   Deepgram Nova-3 ──── transcript + final ──┐               Deepgram Nova-3 ──── transcript + final ──┐
                                              │                                                          │
       ┌──────────────────────────────────────▼                       ┌──────────────────────────────────▼
       │ NumberNormaliser     ("nought point seven" → "0.7")          │ NumberNormaliser     [Phase 1]
       └──────────────────────────────────────┬                       └──────────────────────────────────┬
                                              │                                                          │
       ┌──────────────────────────────────────▼                       ┌──────────────────────────────────▼
       │ TranscriptFieldMatcher                                       │ TranscriptFieldMatcher        [Phase 3]
       │   - 6 pattern categories                                     │   - same 6 categories
       │   - 500-char rolling window                                  │   - same 500-char window
       │   - returns RegexMatchResult                                 │   - returns RegexMatchResult
       └──────────────────────────────────────┬                       └──────────────────────────────────┬
                                              │                                                          │
       ┌──────────────────────────────────────▼                       ┌──────────────────────────────────▼
       │ applyRegexValue(key, value, …)                               │ applyRegexValue           [Phase 4]
       │   if currentValue empty → apply, fieldSources[key]=.regex    │   same rules
       │   else if fieldSources[key]==.regex → overwrite (last-wins)  │
       │   else → no-op                                               │
       └──────────────────────────────────────┬                       └──────────────────────────────────┬
                                              │                                                          │
                                              ▼                                                          ▼
       ┌─────────────────────────────────────────                       ┌─────────────────────────────────────────
       │ Send transcript + regex-hints to backend                       │ Send transcript + regex-hints       [Phase 5]
       │ (`buildRegexSummary` packs `{field, value?}` array)            │   (extend SonnetSession.sendTranscript)
       └─────────────────────────────────────────┬                       └─────────────────────────────────────────┬
                                                 │                                                                  │
                                                 ▼                                                                  ▼
       ┌─────────────────────────────────────────                       ┌─────────────────────────────────────────
       │ Sonnet response → applySonnetValue(key, value, …)              │ applySonnetValue                    [Phase 4]
       │   blocks pre-existing duplicates                               │   same rules
       │   overwrites regex values when different (discrepancy log)     │
       │   overwrites pre-existing only when different                  │
       └─────────────────────────────────────────                       └─────────────────────────────────────────
```

## Scope decisions made up front

1. **Don't port iOS line-for-line.** The 2,128-line iOS matcher accreted
   over a year of voice-quality work. Many of its branches handle one-off
   edge cases. The plan ports the *contract* (regex categories + apply
   rules + hint protocol) and rebuilds the matcher core idiomatically in
   TS. We aim for ~600-800 LoC total, not 2,128.

2. **Start with the 6 documented regex categories.** `default_config.json`
   declares: `insulation_resistance`, `ring_continuity`, `loop_impedance`,
   `rcd`, `polarity`, `earth_continuity`. Ship those first. Anything iOS
   does outside these (designation matching, board switch detection, new
   circuit creation from speech) is **explicitly out of scope** for the
   first release — defer to a v2 once the v1 has soaked.

3. **Field-source tracking is unconditional, regex matching is feature-
   flagged.** Add the `FieldSource` enum + `fieldSources` map even before
   the matcher lands so the apply layer can carry the priority rules from
   day one, and so we can ship Phases 1–4 incrementally without breaking
   the existing 2-tier flow. The matcher itself goes behind a flag we can
   flip per-environment.

4. **No new backend endpoints.** iOS already sends regex-hint metadata via
   the existing `transcript` message; backend already understands it.
   Web's job is purely to start sending what backend already accepts.

5. **No UI changes in v1.** LiveFillView already exists on web; the regex
   tier feeds into it via the same `liveFill.markUpdated` channel. A
   later phase can add a "regex-set" visual distinction (yellow flash) if
   the user wants it; v1 just blue-flashes regardless of source.

## The phases

Each phase is a single-PR-sized chunk. Each ends with a codex review pass.
Each shipped commit follows the same convention as the Wave-B run
(`feat(pwa)/fix(pwa)/test(pwa)/docs(parity)` prefixes; multi-line commit
bodies that explain why; pre-commit hook runs lint + tests).

### Phase R0 — Plan + branch + INDEX update (~½ day)

- Land **this document** on a new branch `pwa-regex-tier`.
- Add a row to `web/audit/INDEX.md`'s Wave B fix-progress table:
  `R0 — Plan committed`.
- No code yet. Establishes the branch + documents intent.

**Codex review:** doc-only review of the plan itself for missing scope or
hidden coupling. Sometimes catches "you said no UI but you're touching the
LiveFill chip" before any code lands.

---

### Phase R1 — `NumberNormaliser` port (~1 day)

Smallest standalone unit. Pure text-in / text-out. Zero side effects.

- New file: `web/src/lib/recording/number-normaliser.ts` — port iOS
  `NumberNormaliser.swift` byte-for-byte where possible.
  - "nought" / "naught" / "zero" → "0"
  - "point" → "."
  - "five point seven six" → "5.76"
  - "thirty" / "thirty two" → "30" / "32"
  - "kelvin" / "milliamp" / "millisecond" / "ohm" / "megohm" passthroughs
  - Number-with-unit ("ten amps" → "10 amps") preserved
- Wire into `recording-context.tsx` so every `onFinalTranscript` text
  passes through normaliser before being sent to Sonnet AND before
  Phase 3's matcher runs.

**Tests** (`web/tests/number-normaliser.test.ts`, ~20 cases):
- Spoken integers / half-integers / units
- Decimal points spoken as "point" + decimal-already-typed tolerance
- Compound speech ("zero point seven six megohms")
- iOS golden-set parity (port the existing iOS unit-test corpus)

**Codex review:** look for spoken-form edge cases the regex authors miss.
Codex tends to flag "what about 'zero zero seven'?" and similar.

---

### Phase R2 — `FieldSource` tracking + `applyRegexValue` / `applySonnetValue` rules (~1.5 days)

Adds the priority machinery without yet running any regex. The
`applyRegexValue` codepath stays unreachable in this phase — it lands
ready to receive matcher output in Phase 4.

- New file: `web/src/lib/recording/field-source.ts`:
  ```ts
  export type FieldSource = 'regex' | 'sonnet' | 'preExisting';
  export class FieldSourceMap { … }
  ```
  - `set(key, source)` / `get(key)` / `clear()` methods
  - `originallyPreExistingKeys: Set<string>` for the iOS-parity Sonnet-
    overwrites-pre-existing tracking
- Extend `recording-context.tsx`:
  - Mount a `FieldSourceMap` instance per session.
  - On session start, walk the existing job and mark every populated
    field as `'preExisting'`.
  - Refactor `applyExtraction` to route through new
    `applySonnetValue(key, newValue, currentValue, apply)` helper that
    encodes the iOS rules.
  - Add `applyRegexValue(key, newValue, currentValue, apply)` (callable
    but not yet called).
- Don't touch the LiveFillView wiring yet. The map is internal state.

**Tests** (`web/tests/field-source-map.test.ts` + extend
`apply-extraction.test.ts`, ~20 cases):
- `applySonnetValue` blocks duplicate writes against pre-existing fields
- `applySonnetValue` overwrites a `'regex'`-source field when different
  (discrepancy path)
- `applySonnetValue` overwrites a pre-existing field when different
  (preexisting_overwrite path) but tracks the original source
- `applyRegexValue` writes to empty fields and last-wins within `regex`
- `applyRegexValue` no-ops against `sonnet`-source or pre-existing fields
- `originallyPreExistingKeys` survives Sonnet overwrites so future
  questions about that field stay suppressed

**Codex review:** the priority rules are subtle. A second pair of eyes
on the truth-table is well worth it.

---

### Phase R3 — `TranscriptFieldMatcher` core engine + 6 regex categories (~3 days)

The biggest phase. Splits naturally into three sub-commits if it grows.

- New file: `web/src/lib/recording/transcript-field-matcher.ts`:
  - Inline the 6 regex-pattern groups from
    `default_config.json#regex_patterns` (already exists on backend; web
    doesn't fetch it, so inline as TS constants like Phase B5 did for
    keyword boosts).
  - Public surface:
    ```ts
    export interface RegexMatchResult {
      supplyUpdates: SupplyUpdates;
      circuitUpdates: Map<string /* circuitRef */, CircuitUpdates>;
      // No board / installation / new-circuit in v1 — out of scope.
    }
    export class TranscriptFieldMatcher {
      match(transcript: string, job: JobDetail): RegexMatchResult;
    }
    ```
  - Internals: per-category extractor functions (`extractInsulation`,
    `extractRingContinuity`, `extractLoopImpedance`, `extractRcd`,
    `extractPolarity`, `extractEarthContinuity`).
  - 500-char rolling window (caller clips, function does not double-clip
    — same iOS contract).
- Sub-commit split if needed:
  - R3a: insulation_resistance + ring_continuity (the two highest-volume
    categories — most readings during a session)
  - R3b: loop_impedance + rcd (next two)
  - R3c: polarity + earth_continuity + dedup logic + 500-char window

**Tests** (`web/tests/transcript-field-matcher.test.ts`, ~60 cases —
ported from iOS `TranscriptFieldMatcherTests.swift`):
- Per category: at least 3 positive matches + 2 negative (no false-fire)
- Rolling window: lastProcessedOffset advances; old text doesn't re-match
- Multi-circuit context: "circuit 7 IR live-earth two megohms ... circuit
  12 IR live-earth nought point seven megohms" → both circuits get the
  right value
- Pre-normalised input: matcher relies on Phase 1 normaliser; tests pass
  already-normalised text and assert no "spoken number" branch fires

**Codex review:** regex correctness. Codex is good at spotting
catastrophic backtracking, missing word-boundary anchors, and patterns
that match more than they advertise.

---

### Phase R4 — wire matcher into recording-context + LiveFill (~1.5 days)

Connect Phases 1+2+3.

- In `recording-context.tsx`:
  - On every final transcript: `normalised → fieldMatcher.match → apply
    each result via applyRegexValue → updateJob`.
  - Mark regex-set fields in LiveFillState (uses the existing
    `liveFill.markUpdated` channel — no LiveFillView changes).
  - Build the regex-hint summary (mirrors iOS `buildRegexSummary`).
- Behind a `NEXT_PUBLIC_REGEX_TIER_ENABLED` env flag, default `false`
  for safety. Flip to `true` in staging first; production after a soak.
- Add the matcher's `RegexMatchResult` to the `applyExtraction` flow
  AHEAD of Sonnet so the field-source map gets stamped before any
  Sonnet response can land.

**Tests** (`web/tests/recording-context-regex-tier.test.tsx`, ~10 cases):
- Final transcript → regex matches → job patched with regex values
- Subsequent Sonnet extraction with same value → no double-write,
  field-source flips `regex → sonnet` only on actual difference
- Subsequent Sonnet extraction with different value → discrepancy
  log + Sonnet overwrites
- Flag OFF → matcher.match never called (preserve existing behaviour)

**Codex review:** integration sequencing. Off-by-one on the order in
which (transcript send / matcher run / liveFill update) happens can
visually flicker the field; codex catches that.

---

### Phase R5 — backend hint protocol + Sonnet awareness (~1 day)

Web already sends `{type: 'transcript', text}` to `/api/sonnet-stream`.
Extend with the regex-hint envelope iOS has been sending since 2026-02.

- In `sonnet-session.ts`:
  - Extend `sendTranscript(text, options)` signature to accept
    `regexHints: Array<{field: string; value?: string}>`.
  - When provided, attach as `regex_fields` on the transcript wire
    payload (matches iOS `buildRegexSummary` shape).
- In `recording-context.tsx`:
  - After regex-apply, build the hint summary from the
    `FieldSourceMap` (filter to `'regex'`-source keys; include `value`
    for postcode-style fields per iOS pattern).
  - Pass into `sendTranscript`.
- **No backend changes.** The server already accepts and uses the
  field — web is just starting to send it.

**Tests** (extend `sonnet-session-heartbeat-and-update.test.ts`, ~3 cases):
- `sendTranscript` with regex hints → wire payload contains `regex_fields`
- `sendTranscript` with no hints → wire payload omits the field
  (backwards-compatible with current behaviour)
- Postcode hint includes `value`; numeric hints don't (iOS contract)

**Codex review:** wire compatibility. Codex catches "what if the value
is null vs undefined vs empty string" issues that backend zod schemas
care about.

---

### Phase R6 — staging soak + observability (~1 week real-time, ~½ day work)

No code change in this phase — it's a deliberate pause to validate.

- Flip `NEXT_PUBLIC_REGEX_TIER_ENABLED=true` in staging.
- Run a recording session against the iOS-parity audio fixtures (`assets/`
  if any are checked in, otherwise the inspector's typical workflow).
- Check that:
  - LiveFillView flashes happen near-instantly on numeric readings
  - Sonnet's `discrepancy_overwrite` log fires on actual disagreement
    (proves the priority chain works)
  - Sonnet's per-turn cost drops measurably (compare 5 sessions
    pre/post)
  - No fields end up wrongly stuck on regex value (matcher false-positives)
- If anything is wrong: revert the flag, file a bug, fix in R6.x.
- If clean after 5 sessions: flip the flag in production.

---

### Phase R7 — production cutover + INDEX close (~½ day)

- Flip `NEXT_PUBLIC_REGEX_TIER_ENABLED=true` in production.
- Update `web/audit/INDEX.md`: mark "Regex layer" + "3-tier field
  priority" CLOSED. Move both items out of the "deferred" list, into
  the Wave B fix-progress table.
- Add a section to the `Deliberate divergence` log noting that v1
  ships only the 6 default regex categories (no designation matching,
  no board switch detection, no new-circuit-from-speech) — those are
  iOS extensions that the web port deliberately deferred.

---

## Out-of-scope follow-ups (record now so they don't get forgotten)

These were considered and explicitly deferred. Not part of this plan.

- **Designation-based matching** ("kitchen sockets ring continuity zero
  point three" → match by label not number). iOS has it via
  `RegexMatchResult.NewCircuit` flow; ~400 lines of additional iOS code.
  Defer to v2 once v1 ships.
- **Board switch detection** ("now testing distribution board 2"
  → switch active board). iOS has it; web has no multi-board recording
  flow yet. Couple to that work, not this one.
- **New-circuit-from-speech** ("circuit 22 cooker, four millimetres squared
  …"). iOS auto-creates rows; web's circuits page already has manual add.
  Defer to a later UX cycle.
- **Visual "regex-set" distinction in LiveFillView.** v1 piggy-backs on
  the existing blue flash. If the inspector wants to *see* "this came
  from regex", that's its own UX commit.

---

## Time estimate summary

| Phase | Estimate | Cumulative |
|---|---|---|
| R0 — plan + branch | ½ day | 0.5 d |
| R1 — NumberNormaliser | 1 day | 1.5 d |
| R2 — FieldSource + apply rules | 1.5 days | 3 d |
| R3 — Matcher engine + 6 categories | 3 days | 6 d |
| R4 — Wire into recording-context | 1.5 days | 7.5 d |
| R5 — Backend hint protocol | 1 day | 8.5 d |
| R6 — Staging soak (mostly waiting) | ½ day work | 9 d work + 1 wk soak |
| R7 — Production cutover | ½ day | 9.5 d |

**Single coder, focused**: ~2 weeks of work plus a 1-week soak window.

**Multiple coders in parallel**: R1, R2, R3 can ship in any order (R3
depends on R1's normaliser only at the test-fixture level — both can be
in flight simultaneously). R4 needs all three before it can integrate.

---

## Risks + mitigations

1. **Regex false-positives stick to fields permanently.**
   *Mitigation:* `applyRegexValue` is last-write-wins within `regex`-
   source, so a corrected re-utterance fixes it. Sonnet then overwrites
   on the next turn if the inspector's next utterance disagrees. The
   feature flag in R6 lets us roll back instantly if false-positives
   exceed Sonnet's correction rate.
2. **Matcher CPU cost on the main thread.**
   *Mitigation:* iOS's 500-char rolling window keeps execution constant-
   time. Same here. Profile in R6; if it's a problem, hoist to a Web
   Worker (cheap, the matcher is pure).
3. **Regex hint protocol drift between iOS and web.**
   *Mitigation:* iOS shape is stable since 2026-02. Pin the wire shape
   in a shared-types interface in R5 so future drift triggers a CI fail.
4. **Phase R3 is too big.**
   *Mitigation:* Pre-split into R3a/R3b/R3c (paired-up categories) so
   each sub-commit is reviewable in under an hour.
5. **iOS keeps shipping regex changes mid-port.**
   *Mitigation:* Snapshot iOS at the R0 plan-commit hash and freeze the
   port against that. After R7, file a separate "rebase regex tier
   against iOS HEAD" task on the audit backlog.

---

## How to resume

1. Open this file (`web/audit/REGEX_TIER_PLAN.md`) — you're reading it.
2. Read `web/audit/INDEX.md` "All audit P0 backlog items closed or
   deferred — handoff state" section for the deferred-item context.
3. Confirm iOS source paths haven't moved
   (`CertMateUnified/Sources/Recording/TranscriptFieldMatcher.swift`).
4. Cut a new branch off `main`: `git checkout -b pwa-regex-tier`.
5. Start at R0; one phase per PR; codex review between phases.
6. Each phase's commit body should mirror the Wave-B convention:
   what / why / why-this-approach / test plan / vitest count.
