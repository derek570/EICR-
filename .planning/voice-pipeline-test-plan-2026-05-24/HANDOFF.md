# Handoff — voice-pipeline regression + prompt-engineering follow-ups
*2026-05-24 — Author: claude-opus session derek/main. Read this whole file before touching anything.*

## TL;DR

Today we (1) turned on Loaded Barrel in production, (2) shipped a
two-layer fix for a designation-loop bug that lost a real
inspector's circuit, and (3) built a one-command regression harness
that exercises the Stage 6 tool-loop + Loaded Barrel speculator with
the real Sonnet model. The harness runs in ~5m 40s for ~$0.65 and is
the verification path for any future change touching the voice
pipeline.

**Three things still failing that need prompt-engineering work** —
those are this handoff's main targets. None block shipping today's
fixes.

## What shipped (read git log for full bodies)

| Commit | Change | Status |
|---|---|---|
| `539e8a9` | `VOICE_LATENCY_LOADED_BARREL=true` in `ecs/task-def-backend.json` | Deployed (task-def `eicr-backend:218`). Prod confirmed alive — first HIT observed session BE5F8120 at 07:42:44 UTC. |
| `e89aa22` | Dispatcher regression test pinning prod-shape designation-omitted bucket | Merged main |
| `1d912b5` | Direct-replay harness + 4 designation scenarios | Merged main |
| `7f0cf4d` | Designation key-mismatch fix (2 mutators + 1 reader + 1 defensive + 2 recency pushes + 6 tests) | Deployed (task-def `eicr-backend:219`). Direct-harness repro: 117 s → 16 s, 3 ask_users → 0. |
| `d9bc2bc` | Regression harness + 12 new scenarios + Markdown report generator | Merged main, run-on-demand |

**The full test plan lives at** `.planning/voice-pipeline-test-plan-2026-05-24/PLAN.md`.
This handoff is the "what's left" subset of it.

## How to run the regression button

```bash
cd /Users/derekbeckley/Developer/EICR_Automation
npm run voice-regression
# → ~5m 40s wall, ~$0.65 cost
# → writes voice-regression-report.md
# → exit 0 if all green, 1 otherwise
```

Requires AWS credentials (the script pulls `ANTHROPIC_API_KEY` +
`ELEVENLABS_API_KEY` from `eicr/api-keys` secret). No backend
running; no Postgres; no TestFlight.

To run a single scenario by name fragment:

```bash
npm run voice-regression -- --filter=designation
```

To run the underlying direct-replay harness against one YAML:

```bash
node scripts/voice-latency-bench/transcript-replay-direct.mjs \
  --scenario=tests/fixtures/voice-latency-scenarios/baseline/new_circuit_then_readings.yaml
```

## Current scoreboard

**2026-05-24 update — Items 1–4 closed.** Full suite **22/22 pass**
post-fix. Shipped via commits `272e6b7` (BS-EN), `0c9a1b9` (phantom-
circuit), `5425479` (polarity). Not yet deployed — push to main when
ready.

| Scenario | State | Notes |
|---|---|---|
| All 22 baseline scenarios | ✅ pass | Full-suite 22/22 (2026-05-24 post-fix) |
| `bs_en_normalisation` | ✅ pass | Item 1 — prompt + tool-schema + dispatcher BS canonical + start_dialogue_script perTurnWrites backfill. 5/5 isolated runs post-fix (was 0/5). |
| `ocpd_full_spec` | ✅ pass | Item 2 — same prompt + tool-description fix as Item 1; 2/2 isolated runs (was 0/5). |
| `hallucinated_phantom_circuit` | ✅ pass | Item 3 — prompt cross-turn rule + dispatcher duplicate-designation guard. 3/3 isolated. |
| `new_circuit_then_readings` | ✅ pass | Item 3 — same fix. 5/5 isolated (was 0/5; handoff documented 20% flake, baseline today was 0%). |
| `normal_polarity` | ✅ pass (value-pinned to "Y") | Item 4 — prompt enum guidance + dispatcher coercion (true/correct/etc. → Y). Scenario assertion tightened to require canonical. |
| `reading_chain_one_circuit` | ✅ pass | Updated alongside Item 4 — `value: true` assertion → `value: "Y"` to match the new canonical. |

## Open items, prioritised

### Item 1: "OCPD BS NNNN" doesn't extract `ocpd_bs_en`

**Symptom.** Inspector says `"Circuit one OCPD BS 6898."` — Sonnet
extracts NOTHING. No `record_reading(ocpd_bs_en, …)`, no ask_user.
Silent drop.

**Why this matters.** `parseBsCode` was hardened on 2026-05-13
(commit `c36f75a`) to fuzzy-match digit runs against canonical BS-EN
forms with Levenshtein-1 — exactly to handle Deepgram dropping the
leading 0 from "60898" → "6898". That fix lives downstream of the
dispatcher, but the model never reaches the dispatcher with this
transcript shape. The prompt teaches `ocpd_bs_en` extraction with
"BS-EN NNNN" / "BS EN NNNN" patterns; "OCPD BS NNNN" appears to be
unrecognised.

**Repro.** `npm run voice-regression -- --filter=bs_en_normalisation`.
~$0.02, ~8 s.

**Where to look first.**
- `config/prompts/sonnet_extraction_system.md` — search for `ocpd_bs_en`
  and the BS-EN extraction guidance. The current examples likely all
  use "BS EN NNNN".
- `src/extraction/dialogue-engine/parsers/bs-code.js` — the parser is
  fine; it's not in the call path here. Don't change it.

**Suggested fix shape.** Add an `OCPD BS NNNN` example to the prompt's
ocpd_bs_en section, including the Deepgram-dropped-leading-zero case.
Verify with the regression scenario. Cost of iteration: $0.02 per
run.

**Verification.** Regression scenario `bs_en_normalisation` flips
green. CloudWatch query for prod-side regression:
```
fields @timestamp, sessionId, message, textPreview
| filter message = 'Extracting from transcript'
| filter textPreview like /OCPD BS/
```

---

### Item 2: Multi-field-in-one-utterance extraction drops 2/3

**Symptom.** Inspector says `"Circuit three is a 32 amp B-curve MCB,
BS EN 60898."` — Sonnet extracts `ocpd_rating_a: 32` and stops.
Drops `ocpd_type: B` and `ocpd_bs_en: BS EN 60898`.

**Why this matters.** Inspectors batch OCPD details in one breath
all the time. This is a real productivity gap, not an edge case.

**Repro.** `npm run voice-regression -- --filter=ocpd_full_spec`.
~$0.03, ~10 s.

**Where to look first.**
- `config/prompts/sonnet_extraction_system.md` — the extraction
  guidance probably doesn't show a multi-field-per-utterance
  example for OCPD. Possibly the model is short-circuiting after
  the first match.
- Tool-loop round count: this scenario's `live_extractions[].rounds`
  is the diagnostic. If rounds=1, the model exited the tool-loop
  before extracting the remaining fields. If rounds=2+, the model
  KNEW there was more but didn't loop back to extract.

**Suggested fix shape.** Add a multi-field OCPD example to the prompt
("here's a transcript with rating + type + BS-EN all in one utterance;
emit three record_reading calls in the same turn"). Possibly tighten
the tool-loop bundler to recognise unprocessed entities in the
transcript.

**Verification.** Same scenario flips green.

---

### Item 3: Phantom-circuit hallucination on multi-turn designation flow

**Symptom (~20% rate).** Inspector says:
1. "Circuit two is upstairs lighting."
2. "Zs for upstairs lighting is 0.33."
3. "R1 plus R2 for upstairs lighting is 0.64."

Most runs end correctly with c2 having both readings. **Sometimes**
Sonnet creates an additional phantom c1 with the same designation
("Upstairs Lighting"), then routes the second or third reading to
that c1 instead of c2. The schedule ends up with two circuits both
labelled "Upstairs Lighting", one of which has readings on it.

**Why this matters.** This is the same prod bug class as
286D500D-2026-05-24 — bad data lands silently and is hard to spot in
the certificate review. We fixed the OBVIOUS case (key-mismatch made
designation invisible) but the model still emits speculative-create
sometimes.

**Repro.** `npm run voice-regression -- --filter=new_circuit_then_readings`
or `--filter=hallucinated_phantom_circuit`. Run 5 times to observe
the flake.

**Where to look first.**
- `config/prompts/sonnet_extraction_system.md` — search for the
  "NEVER HALLUCINATE A CIRCUIT REFERENCE" line and the
  "NO DUPLICATE-DESIGNATION CREATES" guidance. These rules exist
  but the model violates them. Tightening with a concrete
  counterexample might help.
- `src/extraction/stage6-dispatchers-circuit.js:dispatchCreateCircuit`
  — the validator currently allows duplicate designations across
  circuit refs. Adding a soft "designation already used on c<N>"
  warning to the tool result might steer the next turn.
- `src/extraction/stage6-shadow-harness.js:298` — speculator setup;
  not the bug source but worth noting that speculative-create + LB
  pre-synth on the wrong circuit would still HIT and confidently
  TTS the wrong context.

**Suggested fix shape (in priority order).**
1. **Prompt fix**: add the exact failing scenario to the prompt's
   anti-hallucination section ("if you've ALREADY created c2 with
   designation X, NEVER create c1 with designation X in a later
   turn — those are the same circuit"). Try this first; cheapest.
2. **Dispatcher cross-check**: in `dispatchCreateCircuit`, if the
   designation already exists on another circuit_ref in the same
   board, return a soft error or auto-resolve to the existing
   bucket. Tighter, but might break legitimate "same designation,
   different boards" cases — be careful.

**Verification.** Run `new_circuit_then_readings` 5 times via
`for i in 1 2 3 4 5; do npm run voice-regression -- --filter=new_circuit_then_readings; done`.
Pre-fix it should be ~80% green; post-prompt-fix should be 100%.
Then `hallucinated_phantom_circuit` should match.

---

### Item 4: `polarity_confirmed` schema-vs-output mismatch

**Symptom.** Schema allows `["", "OK", "Y", "N"]` for
`polarity_confirmed` (see `config/field_schema.json:166`-ish).
Sonnet writes:
- `"Y"` for `"All circuits polarity confirmed"` (canonical, correct)
- `true` (boolean string) for `"Circuit twelve polarity confirmed"` (off-schema)

The current regression scenario `normal_polarity` asserts
value-agnostic to skirt this; the proper fix is to tighten the
prompt so the model always emits a schema-valid enum.

**Repro.** Hard to test directly — current scenario passes
value-agnostic. To re-tighten:
```yaml
# in tests/fixtures/voice-latency-scenarios/baseline/normal_polarity.yaml
has_reading:
  - circuit: 12
    field: polarity_confirmed
    value: "Y"  # add this back
```
Then run. It should fail today.

**Suggested fix shape.** Add explicit guidance to the prompt's
`polarity_confirmed` section: "values are from the enum {Y, N, OK}.
Never emit booleans or 'true'/'false' strings." Cross-reference
field_schema.json. Possibly add input-canonicalisation to the
dispatcher's `validateRecordReading` so `true` → `Y` even if Sonnet
emits it wrong.

**Verification.** Tighten the scenario's value assertion. Suite goes
green.

---

## Things NOT to break

1. **iOS wire-meta `designation` key.** `perTurnWrites.circuitOps[].meta.designation`
   is the WIRE shape iOS pins via `ClaudeService.swift:201` +
   `DeepgramRecordingViewModel.swift:5057`. Changing this kills
   designation rendering on every active iOS client. Snapshot key
   IS `circuit_designation` (canonical, post today's fix) but wire
   stays `designation`. Comments at both writer sites explain this;
   leave them.

2. **`stage6-snapshot-mutators.js:120, 294`** — `target.circuit_designation`
   is canonical. Don't revert to `target.designation`.

3. **Loaded Barrel TTL (15 s)** in `src/extraction/loaded-barrel-cache.js:44`.
   Field testing today (low signal) caused a MISS at 27.6 s into a
   turn. Tempting to raise TTL → don't, without thinking through
   the staleness implication: a longer TTL serves stale pre-synth
   audio if the inspector moves to a different circuit before
   claiming. The current 15 s is the documented sweet spot from
   plan v10 §F1.

4. **The regression scenarios** in `tests/fixtures/voice-latency-scenarios/baseline/`.
   These are reproducers for past or potential prod bugs. Don't
   soften assertions to make a failing scenario green — fix the
   prompt/code that's failing instead.

5. **The `voice_latency.outcome` event surface.** The regression
   harness, the prod CloudWatch dashboard, and the readiness probe
   all subscribe to the same outcome stream. Adding outcomes is
   fine; renaming or removing them breaks everything downstream.

## How to verify the prod side is still healthy

```bash
# Task-def 219 should be live with VOICE_LATENCY_LOADED_BARREL=true
aws ecs describe-task-definition --task-definition eicr-backend --region eu-west-2 \
  --query 'taskDefinition.containerDefinitions[0].environment[?name==`VOICE_LATENCY_LOADED_BARREL`]'

# Loaded Barrel outcome tally for the last hour
aws logs tail /ecs/eicr/eicr-backend --region eu-west-2 --since 1h \
  --filter-pattern "voice_latency.outcome" \
  | grep -oE '"outcome":"loaded_barrel_[a-z_]+"' | sort | uniq -c

# Designation ask-user storms (should be ~0 post-fix)
aws logs tail /ecs/eicr/eicr-backend --region eu-west-2 --since 6h \
  --filter-pattern '"ambiguous_circuit"' | wc -l
```

If the second query shows growing `loaded_barrel_miss` with no
`_hit` events, the cache is empty (speculator not firing). If the
third query trends upward post-fix, the designation key-mismatch fix
regressed somehow.

## Architecture quick-reference (for the next agent)

The pipeline you're working in:

```
transcript → Stage 6 tool-loop → dispatchers → snapshot mutators
                ↓                       ↓
        Sonnet emits tool calls   stateSnapshot.circuits[ref][canonical_key]
                ↓
        bundler folds into result.extracted_readings (wire shape)
                ↓
        iOS apply path writes to job
```

Files you'll touch most:

- `config/prompts/sonnet_extraction_system.md` — the prompt. Most
  items above are prompt fixes.
- `src/extraction/stage6-dispatchers-circuit.js` — create/rename/record
  dispatchers. Validator + recency push live here.
- `src/extraction/stage6-snapshot-mutators.js` — pure state mutators.
  Single-source-of-truth for what gets written to circuit buckets.
- `src/extraction/eicr-extraction-session.js` — the session class.
  Snapshot rendering is at `buildStateSnapshotMessage` (line ~2165).
- `config/field_schema.json` — canonical field names + enum values.
- `tests/fixtures/voice-latency-scenarios/baseline/` — regression
  scenarios.
- `scripts/voice-latency-bench/transcript-replay-direct.mjs` — the
  harness. `voice-regression.mjs` is the orchestrator.

## When you're done

1. Run `npm run voice-regression` and confirm everything you closed
   is now green.
2. Run the full Jest backend suite (`npm test`) — 3,747+ tests
   should remain green; touching the prompt occasionally trips a
   shadow-harness pin (acceptable, just regenerate the snapshot).
3. Commit per the project's CLAUDE.md commit rules — detailed
   message explaining WHY, not WHAT, with the prod-incident link
   if relevant.
4. Push to main; CI deploys in ~30 min. Watch:
   `gh run watch <run-id> --exit-status` (don't poll).
5. Update this handoff doc with what closed and what new items
   surfaced.

## Open items — surfaced 2026-05-24 evening

### Item 5: silent Zs no-op on unresolved designation (prod session 15C9A3AC, 22:22 BST)

**Symptom.** Inspector dictated 3 separate Zs utterances against the
"upstairs lights" circuit:

  - "z s of the upstairs light said 0.6"
  - "Zs at upstairs lights is 0.6."
  - "zeds of the upstairs light is 0.6"

All three were SILENTLY DROPPED. Sonnet emitted 0 tool calls + 0
ask_users + 0 readings on each turn (output_tokens 33, 48, 43 — just
stop text). User stopped the session at 21:24:52 UTC frustrated.

**Root cause (hypothesis).** Turn 5 of the same session had Deepgram
emit `"circuit circuit is upstairs light."` (duplicated "circuit" —
Deepgram quirk). Sonnet correctly created `circuit_ref=2` but
DID NOT also call `record_reading(designation, "upstairs lights")`.
Circuit 2 was created with an empty designation. Subsequent turns
referenced "the upstairs light" by name; with no designation on c2
there was no anchor for the ask-resolver / designation-matcher to
bind to. Instead of asking "which circuit?", Sonnet silently no-op'd
and treated the utterances as chitchat (counter incremented 1, 2, 3
of 8).

**Sibling shape to** the 286D500D bug (key-mismatch fix shipped
earlier today, commit `7f0cf4d`) and the phantom-circuit bug (Item 3
above). All three are designation-loss family bugs but at different
points in the flow:

- 286D500D / phantom-circuit: designation written but not visible
  / Sonnet creates a duplicate.
- 15C9A3AC: designation never written in the first place, AND
  Sonnet silently drops downstream readings instead of asking.

**Where to look first.**

- `config/prompts/sonnet_extraction_system.md` CIRCUIT NAMING rule
  (line 42 — "If the user says 'circuit N is [description]'…").
  Tighten to require BOTH a circuit_updates create AND a
  record_reading(designation, ...) call so the canonical designation
  field gets populated even when the Deepgram-mangled phrasing
  ("circuit circuit is X") survives.
- `src/extraction/stage6-dispatchers-circuit.js` dispatchCreateCircuit —
  consider rejecting create with no designation when the transcript
  context indicates one was intended. Or auto-prompt ask_user
  "what's the designation?" when create lands with designation=null
  on a previously-empty bucket.
- Same prompt — strengthen the rule for unresolved designations:
  when the inspector dictates a reading against "the upstairs
  light" and NO circuit on the schedule matches, the model MUST
  emit `ask_user("Which circuit is upstairs lights?")` rather than
  silently no-op. Right now an unresolved designation triggers
  chitchat-counter increments (3+ in this session) which feels
  worse than asking.

**Repro.**

```yaml
# Suggested new scenario tests/fixtures/voice-latency-scenarios/baseline/garbled_create_then_readings.yaml
job_state:
  boards:
    - { id: main, designation: "DB-1", board_type: main }
  circuits: []

transcript:
  - { at_ms: 0, text: "circuit circuit is upstairs light.", isFinal: true }
  - { at_ms: 5000, text: "Zs at upstairs lights is 0.6.", isFinal: true }

expect:
  has_reading:
    - { circuit: 2, field: circuit_designation, value: "upstairs lights" }  # if we make create force a designation write
    - { circuit: 2, field: measured_zs_ohm, value: 0.6 }
  # OR (less strict variant if create stays without designation):
  ask_user_count: { min: 1 }  # at minimum, Sonnet must ASK rather than silently drop
```

**Verification.** New scenario flips green; re-replay session
15C9A3AC's transcript through the harness and confirm the Zs lands.

### Garbled-transcript scenarios (user-requested, evening 2026-05-24)

Author additional baseline scenarios that exercise mildly-garbled
Deepgram transcripts (duplicated words, dropped articles, run-on
phrasing, common mishearings) so the harness pins the model's
recovery behaviour. Item 5 above is the canonical example; sibling
candidates:

- "circuit circuit two is cooker" (duplicated word, real prod shape)
- "circuit two is is upstairs lighting" (different position)
- "the cooker the Zs is point six" (run-on)
- "circuit number circuit two" (Deepgram filler)

Implementation: copy the bs_en_normalisation scenario shape, vary
the transcript, assert that either (a) the value lands AND the
circuit is properly created with a designation, or (b) an ask_user
fires (the model must NOT silently drop). Run 3x to measure flake.

## Items deferred to a separate work session

These are in the test plan (`PLAN.md`) but explicitly NOT for this
handoff:

- P2 multi-board / sub-board scenarios (4 scenarios)
- P3 ask_user response paths (4 scenarios — harness extension was
  done; scenarios not authored)
- P3 adversarial / negative (5 scenarios)
- P3 long-session (50-circuit + chitchat-resume)
- CI workflow (the user explicitly wants run-on-demand only)
- Real-audio replay harness (separate bug surface)
- HTTP/WS harness (needs local Postgres setup)

Pick them up only if the items above are closed AND the user asks
for more coverage. Otherwise the regression bar in its current state
is the right gate for "did I break the voice pipeline."
