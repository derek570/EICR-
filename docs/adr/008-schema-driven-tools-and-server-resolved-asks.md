# ADR-008: Schema-Driven Tools, Server-Resolved Asks, Shared Value Rules

**Date:** 2026-04-27
**Status:** Accepted

## Context

Field tests of TestFlight Build 311 surfaced six distinct bugs in the Sonnet→iOS extraction pipeline (sessions 61124C7F + 6FF8A837):

1. **1A — bare "Zs" silently routed to board-level `zs_at_db`** instead of asking which circuit (lossy default).
2. **1B — `ask_user` answer never chained to `record_reading`**: Sonnet asked "which circuit?", got "the cooker", produced a TTS confirmation, but never wrote `number_of_points = 4` to circuit 2.
3. **1C — value lost across clarification turns**: user said "I think 16 mil", Sonnet asked which field, user answered "main earth", Sonnet then asked the value AGAIN (already known).
4. **2A — iOS gate stripped "N/A"** as a non-value despite the backend prompt explicitly listing it as valid.
5. **2B — iOS field-mapping switch missed `ir_test_voltage_v`** (canonical name) because it only matched the legacy alias `ir_test_voltage`. Six valid 250V writes silently dropped.
6. **Coverage drift** — no mechanical guard ensured every backend `field_schema.json` entry had an iOS apply case.

These were **not transcription or audio bugs**. All sat in the gap between the backend Stage-6 agentic extraction prompt and the iOS apply layer. Investigation showed the test infrastructure that *should* have caught them (Phase 6 shadow-mode comparator) had structural blind spots:

- Shadow mode short-circuits `ask_user` → bug 1B/1C invisible.
- Shadow mode runs without full state-snapshot context → bug 1A invisible.
- No integration UAT enumerated `field_schema.json` fields against iOS cases → bugs 2A/2B invisible.

The question wasn't "which test was wrong?" — it was "what kind of test would have caught all six?" The answer is structural enforcement, not more prose rules.

### Alternatives considered

1. **Fix the six bugs as point-fixes, keep architecture as-is.** Faster, but the next ten bugs of the same shape would recur — every prose rule the LLM has to follow is a coin-flip. Rejected because the user explicitly identified prompt-treadmill drift as the failure mode to escape.
2. **Move all extraction logic out of the LLM into a deterministic parser.** Considered and rejected: the LLM's strength is interpreting natural speech. We just need to constrain WHERE the LLM has decision-making latitude.
3. **Schema-driven tools + server-side state machine + shared value rules (chosen).** Three changes that together remove ~60% of prompt prose by making the rules structural.

## Decision

### 1. Schema-driven tool generation (already shipped Phase 1, audited 2026-04-27)

`config/field_schema.json` is the single source of truth. `src/extraction/stage6-tool-schemas.js` builds the `record_reading.field` and `record_board_reading.field` enums by reading the schema at module load. Renaming a field in the schema propagates atomically to:

- The Sonnet tool input enum (closed at the API)
- The dispatcher validators (KNOWN_FIELDS check)
- The shadow comparator buckets

**No build-step codegen artefact**, no committed generated file that can drift from its source. ~1ms startup cost.

### 2. iOS apply-coverage parity (NEW 2026-04-27)

`scripts/check-ios-field-parity.mjs` walks `field_schema.json` and parses every `case "..."` literal in `applySonnetReadings`. CI exit-1 on any schema field with no apply case. Catches bug 2B class. Run after every schema or applier edit:

```bash
node scripts/check-ios-field-parity.mjs
```

### 3. Server-side `ask_user` resolution + state machine (NEW 2026-04-27)

`ask_user` tool gets an OPTIONAL `pending_write` property. Sonnet attaches the buffered write when asking to resolve a circuit/context for a value the inspector has already spoken. The dispatcher then:

1. Holds the user reply.
2. Runs the deterministic matcher (`stage6-answer-resolver.js`) against `pending_write` + `available_circuits` from `stateSnapshot`.
3. **High-confidence match** (single number, single designation, "all circuits", "skip") → server emits the buffered write directly through the normal write path (`createAutoResolveWriteHook` in `stage6-dispatchers.js`). Tool result body: `{auto_resolved: true, match_status: "auto_resolved", resolved_writes: [...]}`. Sonnet doesn't write again.
4. **Low-confidence / ambiguous / unparseable** → tool result echoes pending_write + available_circuits + parsed_hint, `match_status: "escalated"`. Sonnet now has full context to act in one more turn.

Effect on the six bugs:

- **1B fixed**: server writes the value, doesn't depend on Sonnet's memory across turns.
- **1C fixed**: pending_write carries the value through the clarification, can't be lost.
- **1A fixed**: prompt routes bare "Zs" through `ask_user` with `pending_write`, the matcher resolves the circuit deterministically.

Conservative confidence threshold — escalation is the safer wrong answer. 80/20 server vs Sonnet split is a target, not a launch metric; field telemetry will tighten it.

### 4. Shared value normaliser + sentinel rules (NEW 2026-04-27)

`src/extraction/value-normalise.js` exports:
- `acceptsAsWrite(v)` — composite gate. Used by iOS applier and backend dispatchers.
- `isValidSentinel(v)` — true for "N/A", "LIM", "∞", etc. (intentional values).
- `isEvasionMarker(v)` — true for "incomplete", "unknown", etc. (model placeholders).
- Frozen `STAGE6_VALUE_RULES` snapshot.

iOS mirror lives in `Sources/Recording/DeepgramRecordingViewModel.swift` and is asserted in tests. Bug 2A class — iOS rejecting a valid backend sentinel — surfaces immediately because the rule set is shared.

### 5. Field rename: `zs_at_db` → `ze_at_db`

Semantic correction: the field stores Ze measured at the consumer side of the distribution board, which is conceptually Ze (external earth fault loop impedance), not Zs (per-circuit). Bare "Zs" speech now ALWAYS routes through `ask_user` with `pending_write` to the per-circuit `measured_zs_ohm`. Bare "Ze" goes to supply-level `earth_loop_impedance_ze`. Explicit "Ze at the board" / "Zs at the board" goes to the renamed `ze_at_db` field.

Backward-compat: iOS `BoardInfo` decoder accepts both `ze_at_db` (canonical) and `zs_at_db` (legacy) on read, writes only `ze_at_db`. Tests in `BoardInfoZeRenameTests` lock both paths.

### 6. Prompt slimming

Now that field enums, ambiguity routing, and value rules are structurally enforced, the system prompt drops:

- Field-name closed-enum prose (the API rejects off-enum at the boundary)
- Confidence-bound rules (dispatcher checks bounds)
- "Remember the buffered value" rules (server state machine handles it)
- One redundant worked example

Net reduction ~25% of the prompt. Fewer rules for the LLM to miss, and the rules that remain are about speech-to-intent (the LLM's strength) — not state management (the server's strength).

## Consequences

### Positive

- **Bugs 1A, 1B, 1C, 2A, 2B all fixed at the architectural level** rather than as point patches.
- **Coverage drift detectable in CI** via the parity script. Adding a field is a single change in `field_schema.json` plus an iOS apply case — the script fails until both are present.
- **Prompt shrinks** — fewer rules means lower per-turn cost and lower miss rate.
- **Observable failures** — every server-resolved ask logs `stage6.ask_user_auto_resolved` or `stage6.ask_user_resolution_escalated`. CloudWatch can split escalation rate by `parsed_hint` to identify matcher-tightening opportunities.
- **Audit trail** — "why did circuit 2 get number_of_points=4?" is fully traceable: ask_user → user reply → matcher verdict → record_reading dispatch.

### Negative / accepted trade-offs

- Sonnet must learn the `pending_write` pattern. The prompt example covers it; if the model regresses, escalation is the failure mode (not a misroute), so the worst case is "ask twice".
- Server-side matcher needs ongoing tuning (number-word lexicon, designation aliases, etc.). Adding rows to `stage6-answer-resolver.js` is cheap and well-tested.
- The legacy `extracted_readings` JSON path on the server is retained but is no longer the parity target. Stage 6 IS the spec — captured in `memory/stage6_only_decision_2026-04-27.md`.

### Verification

- 1403 backend tests pass (`npm test -- stage6`).
- 87 new tests across `value-normalise-rules.test.js`, `stage6-answer-resolver.test.js`, `stage6-dispatcher-ask-pending-write.test.js`.
- iOS field-parity script: 100 schema fields, 0 missing apply cases.
- iOS production build: green.
- iOS `BoardInfoZeRenameTests`: 5/5 pass on Mac Catalyst.
- Smoke replay of the two field-test transcripts confirms all six bugs are fixed.

## References

- Field test sessions: `s3://eicr-files-production/session-analytics/82b54893-220d-49f5-8c55-d677a009787b/{61124C7F-A623-4387-B1AE-02E311FC719C, 6FF8A837-A81B-4176-B161-FA719E9936A2}/`
- Bug-1B repro test: `src/__tests__/stage6-dispatcher-ask-pending-write.test.js`
- Parity script: `scripts/check-ios-field-parity.mjs`
- Field rename test: `Tests/CertMateUnifiedTests/Models/BoardInfoZeRenameTests.swift`
