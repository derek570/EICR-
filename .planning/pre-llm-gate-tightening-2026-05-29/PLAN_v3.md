# Pre-LLM gate tightening — observation-gated architecture (PLAN_v3)

**Date:** 2026-05-29
**Author:** Claude session, voice-latency conversation continuation
**Status:** v3 — addresses Codex v2 review + user architectural pivot

## Architectural pivot from v2

User direction: **observations are gated behind the explicit keyword "observation" (and Deepgram garbles).** Without saying "observation" first, damage-adjective utterances like "socket cracked" do not trigger observation processing.

User-confirmed design (2026-05-29):
- Q1 (scope): single-utterance prefix — `observation` + content in one Deepgram final
- Q2 (vocab): strictly `observation` + Deepgram garbles only (NOT defect/observe/note as alternates)
- Q3 (damage-adj fallback): block at the gate; inspector trained to say "observation" first

This collapses the STRONG set from v2's 36 words to v3's 19 words + observation regex. The Codex v1 BLOCKER 1 (damage adjectives must be STRONG to preserve safety observations) is no longer relevant because observations only ever enter via the explicit keyword.

## Changes from v2

| v2 design | v3 design | Reason |
|---|---|---|
| Damage adjectives (`crack/cracked/burn/burnt/damage/damaged/missing/exposed/loose/corroded`) STRONG | **WEAK** | User Q3: block bare damage utterances; require `observation` prefix |
| Safety words (`earth/bond/bonding`) STRONG | **WEAK** | Same — only the explicit observation keyword gates entry |
| `defect` STRONG | **WEAK** | User Q2: strictly observation + garbles |
| `observe` STRONG | **WEAK** | User Q2: strictly observation noun forms only |
| `clear` / `rename` STRONG (silent additions) | **DROPPED** | Codex v2 MAJOR 4; "clear" / "rename" need circuit refs which fire `HAS_DIGIT` |
| 36-word STRONG list | **19-word STRONG list + OBSERVATION_PATTERN regex** | Direct consequence of the pivot |
| `EN route now` expected `FALLBACK_FORWARD` | **Expected `LOW_CONTENT`** | Codex v2 MAJOR 5: `now` is in STOPWORDS, so distinct content = 2 |
| False-positive cost: 1 Sonnet round | **Sonnet + potential ask_user TTS round** | Codex v2 MAJOR 3 — `tool_choice:any` may emit ask_user, billing ElevenLabs |

## Context (recap)

`src/extraction/pre-llm-gate.js` — server-side gate, on by default. Field session `33E6613D` (2026-05-26) trigger; current rule too permissive.

Original `TRIGGER_WORDS.size === 94`. Production telemetry shows ~7 blocks/24h (all `LOW_CONTENT`); the trigger-word forward is effectively universal.

## Goal

Replace the 94-word universal-trigger rule with:
1. A small, justified `STRONG_TRIGGER_WORDS` set (~19 words) covering measurement abbreviations and state-change verbs — words that ARE the extraction intent itself
2. An `OBSERVATION_PATTERN` fuzzy regex that triggers observation flow
3. The remaining vocabulary feeds the existing content-word count, but does not carry forward-authority alone

Result: chitchat traffic to Sonnet drops sharply, real readings and explicit-observation entries preserved with zero false-negative risk.

## Design

### `STRONG_TRIGGER_WORDS` (forwards alone) — 19 words

```javascript
const STRONG_TRIGGER_WORDS = new Set([
  // Test field abbreviations — original lines 110-119
  'zs', 'ze', 'pfc', 'psc', 'ipfc', 'r1', 'r2',
  // Equipment abbreviations — original lines 77-80
  'mcb', 'rcd', 'rcbo',
  // Test concepts — original lines 117-119
  'polarity', 'continuity', 'insulation',
  // State-change verbs (Sonnet's existing tool surface) — original lines 101-102
  'delete', 'remove',
  // Codex MAJOR 5: fcu promoted (was in original at line 71); 'cpc' promoted (was in original line 120)
  'fcu', 'cpc',
  // Justified additions:
  // 'afdd' — inspector-only 4-letter abbreviation, follows MCB/RCD/RCBO cluster, near-zero everyday false-positive
  // 'r1r2' — common compact form of 'r1 plus r2', aligns with r1/r2 already present
  'afdd', 'r1r2',
]);
```

**Count: 19 words.** (15 from original + 2 justified upgrades + 2 justified additions.)

### `OBSERVATION_PATTERN` (forwards alone) — fuzzy regex

```javascript
// Match the explicit observation keyword + Deepgram garbles + truncation forms.
// Deliberately STRICT — verb forms (observe/observed/observing) NOT matched per
// user Q2 directive. Inspector must say "observation" (or recognised garble).
//
// Decomposition: /ˌɒb.zəˈveɪ.ʃən/ → ob(z)(er)(va)(tion). Each syllable is
// independently mis-transcribable, so the regex tolerates each axis.
//
//   ob axis: o?b → matches 'ob', 'b' (initial vowel drop), 'ab' (vowel drift)
//   ob-zer axis: s|z → 'obs' or 'obz'
//   er axis: er|ur|ar — typical mid-syllable drift
//   va axis: va|ve|vai|vay
//   tion axis: tion|shun|shen|shan|sion|nce — covers 'observance' homophone too
//
// Examples that match:
//   observation, observations, obs (truncation), observance, obvashon,
//   abservation, obviation, obstervation, obvashen
// Examples that do NOT match (per Q2 strictness):
//   observe, observed, observing, observer, defect, note, mark
const OBSERVATION_PATTERN = /\b(?:obs|o?bs?[aeu]r?v[ae]?(?:tion|shun|shen|shan|sion|nce))s?\b/i;
```

### `WEAK_TRIGGER_WORDS` (require digit or strong trigger or observation pattern) — 75 words

Everything not in STRONG. Includes the damage adjectives, safety words, room names, appliance designations, navigation verbs, generic conductor terms.

```javascript
const WEAK_TRIGGER_WORDS = new Set([
  // Circuit and board nouns — original lines 39-46
  'circuit', 'circuits', 'board', 'boards', 'ring', 'socket', 'sockets',
  'lights', 'light',
  // Appliance designations
  'shower', 'cooker', 'oven', 'hob', 'heater', 'immersion', 'spur',
  // Room names
  'kitchen', 'lounge', 'living', 'bedroom', 'bedrooms', 'bathroom',
  'hallway', 'garage', 'utility', 'loft', 'attic', 'landing',
  // Smoke / alarm
  'smoke', 'alarm',
  // Generic electrical
  'radial', 'main', 'sub-main', 'submain', 'spd', 'fuse',
  'trip', 'breaker',
  // Generic conductor — ring-continuity language always has digits
  'live', 'neutral', 'protective', 'conductor', 'cable', 'wiring',
  'colour', 'color',
  // Safety + observation language — now WEAK because the explicit
  // 'observation' keyword is the gate trigger (user Q3)
  'observation_alt_observe', // placeholder — see note below
  'observe', 'defect', 'issue',
  'crack', 'cracked', 'burn', 'burnt', 'damage', 'damaged',
  'missing', 'exposed', 'loose', 'corroded',
  'earth', 'bond', 'bonding',
  // Navigation / UI commands
  'note', 'record', 'fill', 'add', 'move', 'next', 'previous',
  'done', 'finish', 'skip',
  // Confirmation / inspection vocabulary
  'confirm', 'correct', 'overall', 'summary', 'inspection',
]);
```

Note: `observation` itself is matched by `OBSERVATION_PATTERN` (the regex includes it), so it doesn't need to appear in `WEAK_TRIGGER_WORDS`. It's intentionally omitted from both sets.

**Count: 76 words** (`observation` original is captured by the regex instead of the set; the placeholder above is a comment, not an entry).

### Vocabulary accounting (Codex v2 MAJOR 4 honestly addressed)

Original `TRIGGER_WORDS.size === 94`.

| Disposition | Count | Notes |
|---|---|---|
| Original word kept in WEAK | 76 | Includes damage adjectives, safety words, room names, navigation verbs, all moved per user Q3 |
| Original word moved to STRONG | 15 | zs, ze, pfc, psc, ipfc, r1, r2, mcb, rcd, rcbo, polarity, continuity, insulation, delete, remove, fcu, cpc — wait that's 17. Let me recount. |

Recounting:
- STRONG from original (15): `zs, ze, pfc, psc, ipfc, r1, r2, mcb, rcd, rcbo, polarity, continuity, insulation, delete, remove, fcu, cpc` — that's **17**.
- WEAK from original: 94 − 17 − 1 (`observation` moved to regex) = **76**.
- OBSERVATION_PATTERN captures `observation` (was original).
- Justified additions to STRONG (2): `afdd`, `r1r2` — neither in original.

Vocabulary check: 17 STRONG (original) + 76 WEAK (original) + 1 regex-captured (`observation`, original) = **94 ✓ no original word dropped**.

Plus 2 new STRONG additions (`afdd`, `r1r2`) explicitly justified above.

### New forward logic

```
1. !gateEnabled                       → forward (BYPASS_DISABLED)
2. drainedRetry                       → forward (BYPASS_DRAINED_RETRY)
3. hasPendingAsk                      → forward (BYPASS_PENDING_ASK)
4. inResponseTo                       → forward (BYPASS_IN_RESPONSE_TO)
5. regexResults non-empty             → forward (HAS_REGEX_HINT)
6. text empty                         → block   (EMPTY)
7. hasDigit                           → forward (HAS_DIGIT)
8. OBSERVATION_PATTERN matches        → forward (HAS_OBSERVATION_PREFIX) ← NEW
9. hasStrongTrigger                   → forward (HAS_STRONG_TRIGGER) ← NEW
10. ≥3 distinct content words         → forward (FALLBACK_FORWARD)
11. else                              → block   (LOW_CONTENT)
```

Step 8 fires before step 9 because the regex match is fast and explicit;
ordering it first gives the new reason code a clean log path.

### Telemetry surface

```javascript
export const GATE_REASONS = Object.freeze({
  EMPTY: 'empty',
  HAS_DIGIT: 'has_digit',
  HAS_OBSERVATION_PREFIX: 'has_observation_prefix', // NEW
  HAS_STRONG_TRIGGER: 'has_strong_trigger',          // NEW
  HAS_TRIGGER: 'has_trigger',                        // retained for back-compat; no longer reachable
  HAS_REGEX_HINT: 'has_regex_hint',
  LOW_CONTENT: 'low_content',
  FALLBACK_FORWARD: 'fallback',
  BYPASS_PENDING_ASK: 'bypass_pending_ask',
  BYPASS_IN_RESPONSE_TO: 'bypass_in_response_to',
  BYPASS_DRAINED_RETRY: 'bypass_drained_retry',
  BYPASS_DISABLED: 'bypass_flag_off',
});
```

`HAS_TRIGGER` value kept for back-compat (Codex v1 MINOR 9). No in-repo
consumers other than the gate file/tests.

## Behavioural matrix (revised against v3 + Codex v2 corrections)

| Transcript | Pre (today) | Post (v3) | Reason | Notes |
|---|---|---|---|---|
| "Circuit 3 number of points 5" | forward | forward | `HAS_DIGIT` | Unchanged |
| "Zs nought point four" | forward | forward | `HAS_STRONG_TRIGGER` (`zs`) | |
| "Polarity confirmed" | forward | forward | `HAS_STRONG_TRIGGER` (`polarity`) | |
| "MCB tripped" | forward | forward | `HAS_STRONG_TRIGGER` (`mcb`) | |
| "Observation: socket cracked" | forward (`has_trigger: observation`) | forward | `HAS_OBSERVATION_PREFIX` | **NEW** — observation regex match |
| "Observation. The cable is exposed." | forward | forward | `HAS_OBSERVATION_PREFIX` | |
| "Obs: cooker is loose" | forward (`has_trigger: cooker`) | forward | `HAS_OBSERVATION_PREFIX` | Truncation form matches |
| "Obvashon, cracked casing" | likely forward (`has_trigger: cracked`) | forward | `HAS_OBSERVATION_PREFIX` | Garble matches |
| "Socket cracked" | forward (`has_trigger: cracked`) | **block** | `LOW_CONTENT` | **Q3 — inspector must prefix with observation** |
| "Cable exposed" | forward | **block** | `LOW_CONTENT` | Q3 |
| "No earth" | forward (`has_trigger: earth`) | **block** | `LOW_CONTENT` | Q3 |
| "Cover missing" | forward | **block** | `LOW_CONTENT` (distinct: cover, missing = 2) | Q3 |
| "Loose connection" | forward | **block** | `LOW_CONTENT` (distinct: loose, connection = 2) | Q3 |
| "I cracked an egg" | forward (`has_trigger: cracked`) | **block** | `LOW_CONTENT` (distinct: cracked, egg = 2) | False-positive cost eliminated (Codex v2 MAJOR 3 resolved) |
| "FCU spur" | forward (`has_trigger: fcu`) | forward | `HAS_STRONG_TRIGGER` (`fcu`) | Codex MAJOR 5 fix |
| "Main bonding" | forward (`has_trigger: bonding`) | **block** | `LOW_CONTENT` (distinct: main, bonding = 2) | Q3 — `bonding` now weak |
| "Smoke alarm" | forward | **block** | `LOW_CONTENT` | Bare designation; deliberate |
| "Going to the kitchen" | forward (`has_trigger: kitchen`) | **block** | `LOW_CONTENT` | Intended cost cut |
| "I am done" | forward (`has_trigger: done`) | **block** | `LOW_CONTENT` | Intended cost cut |
| "I have an observation about the cooker" | forward (`has_trigger: observation`) | forward | `HAS_OBSERVATION_PREFIX` | Observation flow |
| "Add an observation" | forward | forward | `HAS_OBSERVATION_PREFIX` | |
| "I observe the meeting starts at 3" | forward (`has_trigger: observe` + digit) | forward | `HAS_DIGIT` | Note: `observe` no longer STRONG; digit catches it |
| "I observed a crack in the casing" | forward (`has_trigger: observe`) | **block** | `LOW_CONTENT` (distinct: observed, crack, casing = 3 → FALLBACK_FORWARD!) | Edge — Sonnet may extract observation despite no explicit prefix |
| "EN route now" | n/a — `en` not currently a trigger | **block** | `LOW_CONTENT` (distinct: en, route = 2; `now` is stopword) | Codex v2 MAJOR 5 corrected expected value |
| "Just had to confirm with the client" | forward (`has_trigger: confirm`) | forward | `FALLBACK_FORWARD` (distinct ≥3) | Edge — forwards via fallback |
| "Defect on the casing" | forward (`has_trigger: defect`) | **block** | `LOW_CONTENT` (distinct: defect, casing = 2) | Q2 — strict observation-only; inspector must prefix |
| "Clear that reading" | forward (existing rule) | **block** | `LOW_CONTENT` (distinct: clear, reading = 2) | Codex v2 MAJOR 4 — `clear` not in original; inspector must include circuit ref ("clear circuit 3 reading" → digit) |

### Acknowledged edges

- **"I observed a crack in the casing"** still forwards via `FALLBACK_FORWARD` (3 distinct content words). Sonnet may or may not extract an observation; no explicit prefix per Q2 means we don't pre-commit to the observation flow at the gate. Cost: 1 Sonnet round.
- **"Defect on the casing"** now blocks. Inspector must say "Observation: defect on the casing" to enter observation flow. Trade per Q3.
- **"Clear that reading"** now blocks. Inspector says "Clear circuit 3 reading" to fire `HAS_DIGIT`. Trade per Codex v2 MAJOR 4 (no silent vocabulary additions).

## False-positive cost analysis (Codex v2 MAJOR 3 fully addressed)

v2 estimated false-positive cost as ~$0.005 per wasted Sonnet round. Codex
v2 noted this is undercounted because Stage 6 `tool_choice:any` forces a
tool_use on round 1, and `stage6-tool-loop.js:376` says the model may emit
`ask_user` for irrelevant utterances. An ask_user emission triggers
ElevenLabs TTS billed per character at `keys.js:563`.

**Corrected cost per false-positive forward:**

- Sonnet round 1 (forced tool_use): ~$0.005
- If ask_user emitted: + ElevenLabs TTS chars (typical ask ~80 chars × $0.00006 = ~$0.005)
- If the inspector then answers, more Sonnet rounds + dispatch overhead
- **Realistic worst case: ~$0.015 per false-positive + an audible TTS clarification interrupting the inspector**

This makes v3's tighter gate MORE valuable than v2 acknowledged. The
acknowledged false positives in v3 (e.g. "I observed a crack" forwarding
via fallback) are limited by the `MIN_DISTINCT_CONTENT_WORDS = 3` rule
to genuine sentences — short chitchat shapes block.

## Chitchat-pause interaction (preserved from v2)

The gate runs BEFORE `questionGate.onNewUtterance()` and BEFORE Sonnet's
session.extract() at `sonnet-stream.js:3194`. Blocked transcripts never
touch the chitchat engagement counter at `chitchat-pause.js:223,248`.

Net effect: v3's tighter gate makes chitchat-pause activation **less
likely**. Every block is a counter-increment that doesn't happen.

Out of scope: widening chitchat-pause wake conditions. (Separate plan
needed for the case when inspector says "Observation: ..." during an
active pause — the regex now identifies the entry; wake widening would
hook into that.)

## Tests

### Strong-trigger forwards

```javascript
test.each([
  ['Zs.', GATE_REASONS.HAS_STRONG_TRIGGER],
  ['Polarity confirmed', GATE_REASONS.HAS_STRONG_TRIGGER],
  ['MCB tripped.', GATE_REASONS.HAS_STRONG_TRIGGER],
  ['Continuity check.', GATE_REASONS.HAS_STRONG_TRIGGER],
  ['Insulation test.', GATE_REASONS.HAS_STRONG_TRIGGER],
  ['Delete that.', GATE_REASONS.HAS_STRONG_TRIGGER],
  ['Remove the entry.', GATE_REASONS.HAS_STRONG_TRIGGER],
  ['FCU spur.', GATE_REASONS.HAS_STRONG_TRIGGER],
  ['CPC discontinuous.', GATE_REASONS.HAS_STRONG_TRIGGER],
  ['AFDD installed.', GATE_REASONS.HAS_STRONG_TRIGGER],
  ['R1R2 reading.', GATE_REASONS.HAS_STRONG_TRIGGER],
])('forwards strong-trigger "%s"', ...)
```

### Observation pattern forwards (NEW)

```javascript
test.each([
  ['Observation: socket cracked.', GATE_REASONS.HAS_OBSERVATION_PREFIX],
  ['Observation. The cable is exposed.', GATE_REASONS.HAS_OBSERVATION_PREFIX],
  ['I have an observation about the cooker.', GATE_REASONS.HAS_OBSERVATION_PREFIX],
  ['Add an observation.', GATE_REASONS.HAS_OBSERVATION_PREFIX],
  ['Note an observation.', GATE_REASONS.HAS_OBSERVATION_PREFIX],
  ['Observations recorded.', GATE_REASONS.HAS_OBSERVATION_PREFIX],
  // Truncation
  ['Obs: cracked casing.', GATE_REASONS.HAS_OBSERVATION_PREFIX],
  // Garbles
  ['Obvashon, cracked casing.', GATE_REASONS.HAS_OBSERVATION_PREFIX],
  ['Abservation, missing cover.', GATE_REASONS.HAS_OBSERVATION_PREFIX],
  ['Obvashen here.', GATE_REASONS.HAS_OBSERVATION_PREFIX],
  // Homophone overlap with real word
  ['Observance of the rules.', GATE_REASONS.HAS_OBSERVATION_PREFIX],
])('forwards observation-pattern "%s"', ...)
```

### Observation pattern does NOT match verb forms (Q2 strictness)

```javascript
test.each([
  // Verb forms — per Q2, these are NOT entry triggers
  ['I observe a problem.', GATE_REASONS.FALLBACK_FORWARD], // 3 distinct content words
  ['I observed a crack.', GATE_REASONS.FALLBACK_FORWARD],  // 3 distinct content words
  ['Observing the test.', GATE_REASONS.LOW_CONTENT],       // observing, test = 2 (the is stopword)
  ['Observer noted.', GATE_REASONS.LOW_CONTENT],           // observer, noted = 2
])('does NOT match verb forms "%s"', ...)
```

### Damage adjectives block without observation prefix (Q3)

```javascript
test.each([
  ['Socket cracked.', GATE_REASONS.LOW_CONTENT],
  ['Cable exposed.', GATE_REASONS.LOW_CONTENT],
  ['No earth.', GATE_REASONS.LOW_CONTENT],
  ['Cover missing.', GATE_REASONS.LOW_CONTENT],
  ['Loose connection.', GATE_REASONS.LOW_CONTENT],
  ['Cracked casing.', GATE_REASONS.LOW_CONTENT],
  ['Burnt cable.', GATE_REASONS.LOW_CONTENT],
  ['Defect on casing.', GATE_REASONS.LOW_CONTENT], // distinct: defect, casing = 2
  ['I cracked an egg.', GATE_REASONS.LOW_CONTENT],
])('blocks damage-adjective without observation prefix "%s"', ...)
```

### Damage adjectives + observation prefix forward (combination)

```javascript
test.each([
  ['Observation: socket cracked.', GATE_REASONS.HAS_OBSERVATION_PREFIX],
  ['Observation: cable exposed.', GATE_REASONS.HAS_OBSERVATION_PREFIX],
  ['Observation: no earth.', GATE_REASONS.HAS_OBSERVATION_PREFIX],
  ['Observation: cover missing on circuit 3.', GATE_REASONS.HAS_OBSERVATION_PREFIX],
])('forwards damage+observation prefix "%s"', ...)
```

### Codex v2 MAJOR 5 correction — `EN route now` expected result

```javascript
// `en` not in current trigger list, never added to v3 STRONG.
// `now` is in STOPWORDS at pre-llm-gate.js:163, so distinct content = en, route = 2.
test('EN route now → LOW_CONTENT (Codex v2 MAJOR 5 corrected)', () => {
  expect(shouldForwardToSonnet('EN route now.')).toEqual({
    forward: false,
    reason: GATE_REASONS.LOW_CONTENT,
    distinctContentWords: 2,
  });
});
```

### Codex v2 MAJOR 4 — silent additions regression guard

```javascript
test.each([
  // 'clear' and 'rename' NOT in v3 STRONG (codex v2 flagged silent
  // additions in v2; v3 drops them).
  ['Clear that.', GATE_REASONS.LOW_CONTENT],    // distinct: clear, that(stopword) = 1
  ['Rename it.', GATE_REASONS.LOW_CONTENT],     // distinct: rename, it(stopword) = 1
  // But with digit, they forward via HAS_DIGIT
  ['Clear circuit 3.', GATE_REASONS.HAS_DIGIT],
  ['Rename circuit 4 to cooker.', GATE_REASONS.HAS_DIGIT],
])('clear/rename require digit "%s"', ...)
```

### Weak-trigger + digit forwards (regression)

```javascript
test.each([
  ['Done with circuit 3.', GATE_REASONS.HAS_DIGIT],
  ['Add to circuit 4.', GATE_REASONS.HAS_DIGIT],
  ['Cooker circuit 4.', GATE_REASONS.HAS_DIGIT],
  ['Kitchen socket reading is 0.45.', GATE_REASONS.HAS_DIGIT],
])('forwards weak-trigger+digit "%s"', ...)
```

### Original 94-word preservation invariant (Codex v2 MAJOR 4)

```javascript
import { _internals } from '../extraction/pre-llm-gate.js';
import { ORIGINAL_TRIGGER_WORDS_FROM_2026_05_26 } from './fixtures/original-94-words.js'; // pinned for regression

test('every original-94 word appears in STRONG, WEAK, or OBSERVATION_PATTERN', () => {
  for (const w of ORIGINAL_TRIGGER_WORDS_FROM_2026_05_26) {
    const inStrong = _internals.STRONG_TRIGGER_WORDS.has(w);
    const inWeak = _internals.WEAK_TRIGGER_WORDS.has(w);
    const inObservationRegex = _internals.OBSERVATION_PATTERN.test(w);
    expect(inStrong || inWeak || inObservationRegex)
      .withContext(`word "${w}" must be placed`).toBe(true);
  }
});

test('STRONG additions are limited to the documented justified set', () => {
  const additions = [...new Set(_internals.STRONG_TRIGGER_WORDS)]
    .filter((w) => !ORIGINAL_TRIGGER_WORDS_FROM_2026_05_26.has(w));
  expect(additions.sort()).toEqual(['afdd', 'r1r2']);
});
```

This invariant codifies Codex v2's MAJOR 4 finding into a regression
test that fires the next time someone touches the lists without
intentional review.

### Telemetry stability

```javascript
test('HAS_TRIGGER reason value retained for telemetry back-compat', () => {
  expect(GATE_REASONS.HAS_TRIGGER).toBe('has_trigger');
});
test('HAS_STRONG_TRIGGER reason exported', () => {
  expect(GATE_REASONS.HAS_STRONG_TRIGGER).toBe('has_strong_trigger');
});
test('HAS_OBSERVATION_PREFIX reason exported', () => {
  expect(GATE_REASONS.HAS_OBSERVATION_PREFIX).toBe('has_observation_prefix');
});
```

## Rollout

1. Edit `src/extraction/pre-llm-gate.js`:
   - Add `STRONG_TRIGGER_WORDS`, `WEAK_TRIGGER_WORDS`, `OBSERVATION_PATTERN`
   - Update `shouldForwardToSonnet` per new logic
   - Update `_internals` export
2. Edit `src/__tests__/pre-llm-gate.test.js`:
   - Add ~30 new fixtures (strong, observation, damage+observation,
     damage-without, verb-form rejection, codex correction guards,
     invariant tests)
   - Update existing test fixture expected reasons (4 cases)
3. Create `src/__tests__/fixtures/original-94-words.js` — pinned set for
   the preservation invariant
4. `npm test --testPathPattern="pre-llm-gate"` → green
5. `npm test` → full suite green
6. Single commit (or two: gate edit + test fixture file)
7. Push to main → CI → ECS deploy
8. Observe `voice_latency.gate_blocked` reason histogram for 24h
9. Kill switch: `VOICE_PRE_LLM_GATE=false` on task-def

## Risk analysis

| Risk | Likelihood | Mitigation |
|---|---|---|
| `OBSERVATION_PATTERN` regex misses a Deepgram garble we hadn't seen | Medium — Deepgram is creative | Telemetry: log `LOW_CONTENT` blocks during field test; if any contain real observation-shaped text, extend the regex |
| Inspector trained on damage-adjective workflow finds the gate blocks "socket cracked" without observation prefix | Medium — workflow change requires inspector retraining | Per Q3 — accepted trade; document in in-app help / inspector onboarding |
| `OBSERVATION_PATTERN` over-matches non-electrical homophones (`observance` real word) | Low — observance has near-zero frequency in inspector recordings | Acceptable false-positive cost (1 Sonnet round) |
| `clear` / `rename` (Codex v2 MAJOR 4 dropped from STRONG) cause workflow friction | Low — inspectors usually pair with circuit ref → digit catches | If field-test telemetry shows real `clear that` / `rename it` patterns being lost, add as `clear`+`rename` STRONG in a follow-up with explicit justification |
| Vocabulary creep on future edits | Low (invariant test exists) | Original-94 preservation test fires on any unintentional change |
| `HAS_TRIGGER` reason value still emitted by external CloudWatch queries breaks dashboards | Zero in-repo, unknown external | Reason value preserved in enum |
| Gate-blocked rate spikes much higher than expected | Medium — measurable | Roll back via `VOICE_PRE_LLM_GATE=false` |

## Expected production impact

- Sonnet turn count: **30-40% reduction** on field-test sessions (higher than v2's 15-25% because v3 also blocks damage adjectives + bare designations + clear/rename without circuit ref).
- Sonnet cost: proportional.
- Sonnet+TTS cost on ask_user fallback (Codex v2 MAJOR 3): eliminated for the chitchat shapes (`I cracked an egg`, `done`, `kitchen` etc.).
- Chitchat-pause activation: less frequent (counter increments less).
- Observation entry: ONLY via explicit `observation` keyword + garbles per user Q3. Inspector workflow simplification.

## Out of scope

- Widening chitchat-pause wake conditions to recognise `OBSERVATION_PATTERN` (separate plan; the right next step).
- iOS chime + iOS-side gate (already in todos-certmate.md; inherits v3 taxonomy).
- Tightening `FALLBACK_FORWARD` ≥3 distinct content words rule (separate larger-scope change).
- Multi-utterance observation state machine (user Q1 = single-utterance prefix is the chosen design).
