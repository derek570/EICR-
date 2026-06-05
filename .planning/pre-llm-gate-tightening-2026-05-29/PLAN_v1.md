# Pre-LLM gate tightening — strong/weak trigger split

**Date:** 2026-05-29
**Author:** Claude session, voice-latency conversation continuation
**Status:** v1 — pending self-review + Codex review

## Context

### Existing gate

`src/extraction/pre-llm-gate.js` exists already. Shipped after field session
`33E6613D-49A7-4B42-A73B-1E2C6A82174D` (2026-05-26) which burnt ~£0.30 on 14
panic-asks for transcripts that had no extraction value.

Current forward rule (one of):
1. iOS regex hit on the transcript (`regexResults` non-empty)
2. Session has a pending ask (`hasPendingAsk`)
3. iOS tagged `inResponseTo`
4. Drained-retry replay (`drainedRetry`)
5. **Any digit anywhere** (`HAS_DIGIT`)
6. **Any one of ~140 trigger words** (`HAS_TRIGGER`)
7. ≥3 distinct content words (`FALLBACK_FORWARD`)

Block only if all-of-above fail → `LOW_CONTENT`.

### Production telemetry (last 24 h)

- 7 `voice_latency.gate_blocked` events total
- **All 7 are `low_content`** ("No." / "AC." / etc.)
- **Zero blocks via the trigger-word rule** — the trigger list is so loose
  that essentially everything containing a single keyword passes through

### Why the trigger list is too loose

The 140-word list (`pre-llm-gate.js:36-148`) treats words across very
different signal levels as universal forward-authority:

| Category | Examples | Real-signal? |
|---|---|---|
| Test abbreviations | `zs`, `ze`, `pfc`, `r1`, `r2`, `mcb`, `rcd` | Yes — almost always extraction |
| BS-EN code prefix | `bs`, `en` | Yes — code dictation |
| Action verbs | `clear`, `delete`, `rename`, `spare` | Yes — state change intent |
| Observation intent | `observation`, `observe`, `defect` | Yes — narrative observation |
| Room names | `kitchen`, `lounge`, `bedroom`, `bathroom`, `garage` | No — leaks "I'm in the kitchen" chitchat |
| Appliance names | `cooker`, `oven`, `hob`, `shower`, `heater` | No — leaks "I cooked dinner" / "shower's nice" |
| Navigation verbs | `note`, `record`, `add`, `next`, `previous`, `done`, `finish`, `skip` | No — leaks "make a note" / "I'm done" |
| Damage adjectives | `crack`, `cracked`, `burn`, `burnt`, `damage`, `loose`, `missing`, `exposed` | No — leaks "I cracked an egg" / "loose stones" |
| Generic terms | `main`, `fuse`, `trip`, `breaker`, `live`, `neutral`, `cable`, `wiring` | No — common English |
| Confirmation | `confirm`, `correct`, `overall` | No — `hasPendingAsk` bypass already handles answers |

Each leaky weak-trigger transcript that reaches Sonnet costs ~$0.005 + 3 s
of unnecessary wall-clock + a chitchat-counter increment that contributes
to the 8-turn pause threshold.

## Goal

Tighten the gate so that trigger-words **alone** don't forward unless they
genuinely indicate extraction intent. Cut chitchat traffic to Sonnet without
losing real readings or observations.

## Design — Option A (chosen)

Split `TRIGGER_WORDS` into two named sets:

### `STRONG_TRIGGER_WORDS` — forwards alone

Words whose appearance reliably indicates an extraction-worthy utterance.
Triggering on these alone is safe; in production this is almost always
followed by a value or is itself a state-change command.

```
// Test field abbreviations
'zs', 'ze', 'pfc', 'psc', 'ipfc', 'r1', 'r2', 'r1r2',
// Equipment abbreviations (typically dictated mid-test)
'mcb', 'rcd', 'rcbo', 'afdd', 'spd',
// Test concepts (always paired with values in real usage)
'polarity', 'continuity', 'insulation', 'impedance',
// BS-EN code prefix
'bs', 'en',
// State-change action verbs (intent regardless of accompanying value)
'clear', 'delete', 'remove', 'rename', 'spare',
// Observation intent
'observation', 'observe', 'defect',
```

**Count: ~26 words.**

### `WEAK_TRIGGER_WORDS` — only forward if also has digit OR strong trigger

The remaining ~110 words. Leakage source today; signal in combination.
Demoted because the bare word is too common in everyday speech.

```
// Circuit and board nouns
'circuit', 'circuits', 'board', 'boards', 'ring', 'socket', 'sockets',
'lights', 'light',
// Appliance designations
'shower', 'cooker', 'oven', 'hob', 'heater', 'immersion', 'spur', 'fcu',
// Room names
'kitchen', 'lounge', 'living', 'bedroom', 'bedrooms', 'bathroom',
'hallway', 'garage', 'utility', 'loft', 'attic', 'landing',
// Generic electrical + safety + smoke
'smoke', 'alarm', 'radial', 'main', 'sub-main', 'submain', 'fuse',
'trip', 'breaker', 'live', 'neutral', 'protective', 'conductor',
'cable', 'wiring', 'colour', 'color', 'earth', 'cpc', 'bond', 'bonding',
'earthing',
// Damage adjectives standalone
'crack', 'cracked', 'burn', 'burnt', 'damage', 'damaged', 'missing',
'exposed', 'loose', 'corroded',
// Navigation / confirmation
'note', 'record', 'fill', 'add', 'move', 'next', 'previous', 'done',
'finish', 'skip', 'confirm', 'correct', 'overall', 'summary',
'inspection', 'issue',
```

**Count: ~75 words.**

### New forward logic

Order of checks (bypasses unchanged):

```
1. !gateEnabled                    → forward (BYPASS_DISABLED)
2. drainedRetry                    → forward (BYPASS_DRAINED_RETRY)
3. hasPendingAsk                   → forward (BYPASS_PENDING_ASK)
4. inResponseTo                    → forward (BYPASS_IN_RESPONSE_TO)
5. regexResults non-empty          → forward (HAS_REGEX_HINT)
6. text empty                      → block   (EMPTY)
7. hasDigit                        → forward (HAS_DIGIT)
8. hasStrongTrigger                → forward (HAS_STRONG_TRIGGER)         ← NEW
9. hasWeakTrigger AND hasDigit     → forward (HAS_TRIGGER) — collapsed into 7 above
10. hasWeakTrigger AND hasStrong   → forward (HAS_TRIGGER) — collapsed into 8 above
11. ≥3 distinct content words      → forward (FALLBACK_FORWARD)
12. else                           → block   (LOW_CONTENT)
```

Net: weak triggers alone no longer carry forward authority. They become
weight in the fallback content-word count (via the broader regex
already handling words), but a transcript containing only one weak
trigger word and ≤2 distinct content words now blocks.

### `GATE_REASONS` enum changes

Add: `HAS_STRONG_TRIGGER = 'has_strong_trigger'`

Existing `HAS_TRIGGER` value preserved but no longer reachable for
weak-only-trigger forwards (those now fall through to `FALLBACK_FORWARD`
or `LOW_CONTENT`). Telemetry queries that filter on `has_trigger` will
continue to work; the distribution will narrow.

Strictly, `HAS_TRIGGER` could be deleted, but keeping it avoids breaking
the telemetry/dashboards downstream of the existing reason name.

## Behavioural matrix — expected change

| Transcript example | Pre | Post | Reason |
|---|---|---|---|
| "Circuit 3 number of points 5" | forward | forward | `HAS_DIGIT` (unchanged) |
| "Zs nought point four" | forward | forward | `HAS_STRONG_TRIGGER` (zs) |
| "Clear that reading" | forward | forward | `HAS_STRONG_TRIGGER` (clear) |
| "Add an observation about the cooker" | forward | forward | `HAS_STRONG_TRIGGER` (observation) |
| "BS EN 60898" | forward | forward | `HAS_DIGIT` |
| "Going to the kitchen" | forward (`has_trigger: kitchen`) | **block** | `LOW_CONTENT` (kitchen weak, no digit, 3 content words: going, kitchen → but "going"+"kitchen"+"the"... "the" is stopword, "to" stopword. distinct: going, kitchen = 2 → blocks) |
| "Done with circuit 3" | forward (`has_trigger`) | forward | `HAS_DIGIT` |
| "I'm done" | forward (`has_trigger: done`) | **block** | `LOW_CONTENT` (done weak, no digit, distinct: done = 1) |
| "Just had to confirm with the client" | forward (`has_trigger: confirm`) | **block** | `LOW_CONTENT` (confirm weak, no digit, distinct: had, confirm, client = 3 → forwards via `FALLBACK_FORWARD`). **Edge case: this still forwards via fallback.** Acceptable — 3+ content words means it's a real sentence, not chitchat. |
| "I cracked an egg" | forward (`has_trigger: cracked`) | **block** | `LOW_CONTENT` (cracked weak, no digit, distinct: cracked, egg = 2) |
| "The lights look fine" | forward (`has_trigger: lights`) | **block** | `LOW_CONTENT` (weak, no digit, distinct: lights, look, fine = 3 → forwards via `FALLBACK_FORWARD`). **Edge case: still forwards.** |
| "Cooker circuit 4" | forward | forward | `HAS_DIGIT` |
| "Got an issue here" | forward (`has_trigger: issue`) | **block** | `LOW_CONTENT` (issue weak, no digit, distinct: got, issue = 2 — "here" is stopword? let me check. STOPWORDS includes 'here', 'there'. distinct: got, issue = 2 → blocks) |
| "Defect on the casing" | forward (`has_trigger: defect`) | forward | `HAS_STRONG_TRIGGER` |
| "Polarity confirmed" | forward (`has_trigger`) | forward | `HAS_STRONG_TRIGGER` (polarity) |

## Implementation

### Files touched

1. **`src/extraction/pre-llm-gate.js`** — main change
2. **`src/__tests__/pre-llm-gate.test.js`** — add cases
3. *No env-var change* — `VOICE_PRE_LLM_GATE` remains the master kill-switch

### Code shape

```javascript
const STRONG_TRIGGER_WORDS = new Set([
  'zs', 'ze', 'pfc', 'psc', 'ipfc', 'r1', 'r2', 'r1r2',
  'mcb', 'rcd', 'rcbo', 'afdd', 'spd',
  'polarity', 'continuity', 'insulation', 'impedance',
  'bs', 'en',
  'clear', 'delete', 'remove', 'rename', 'spare',
  'observation', 'observe', 'defect',
]);

const WEAK_TRIGGER_WORDS = new Set([
  /* the rest of the original ~110 words */
]);

const STRONG_TRIGGER_REGEX = new RegExp(
  `\\b(${[...STRONG_TRIGGER_WORDS].map((w) => w.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')).join('|')})\\b`,
  'i',
);

// Existing TRIGGER_REGEX retained for back-compat;
// rebuilt over union of STRONG + WEAK so any audit consuming
// `TRIGGER_REGEX` still sees the full vocabulary.
const TRIGGER_REGEX = new RegExp(
  `\\b(${[...STRONG_TRIGGER_WORDS, ...WEAK_TRIGGER_WORDS].map(...).join('|')})\\b`,
  'i',
);
```

In `shouldForwardToSonnet`:

```javascript
if (DIGIT_REGEX.test(trimmed)) {
  return { forward: true, reason: GATE_REASONS.HAS_DIGIT };
}
if (STRONG_TRIGGER_REGEX.test(trimmed)) {
  return { forward: true, reason: GATE_REASONS.HAS_STRONG_TRIGGER };
}
// Weak-trigger-only path falls through to distinct-content-word count.
// No longer treated as a forward signal by itself.

const distinctContent = new Set();
// ... existing distinct-content-word counter unchanged
```

### `GATE_REASONS` enum

```javascript
export const GATE_REASONS = Object.freeze({
  EMPTY: 'empty',
  HAS_DIGIT: 'has_digit',
  HAS_STRONG_TRIGGER: 'has_strong_trigger', // NEW
  HAS_TRIGGER: 'has_trigger',                // retained for back-compat; no longer reachable from new logic
  HAS_REGEX_HINT: 'has_regex_hint',
  LOW_CONTENT: 'low_content',
  FALLBACK_FORWARD: 'fallback',
  BYPASS_PENDING_ASK: 'bypass_pending_ask',
  BYPASS_IN_RESPONSE_TO: 'bypass_in_response_to',
  BYPASS_DRAINED_RETRY: 'bypass_drained_retry',
  BYPASS_DISABLED: 'bypass_flag_off',
});
```

### `_internals` export

```javascript
export const _internals = Object.freeze({
  TRIGGER_WORDS, // back-compat: union of both
  STRONG_TRIGGER_WORDS, // NEW
  WEAK_TRIGGER_WORDS,   // NEW
  STOPWORDS,
  MIN_DISTINCT_CONTENT_WORDS,
});
```

## Tests

Add to `src/__tests__/pre-llm-gate.test.js`:

### Strong-trigger forwards (new `HAS_STRONG_TRIGGER` reason)

```javascript
test.each([
  ['Zs.', GATE_REASONS.HAS_STRONG_TRIGGER],
  ['Polarity confirmed', GATE_REASONS.HAS_STRONG_TRIGGER],
  ['Clear that.', GATE_REASONS.HAS_STRONG_TRIGGER],
  ['Add an observation.', GATE_REASONS.HAS_STRONG_TRIGGER],
  ['Defect on the casing.', GATE_REASONS.HAS_STRONG_TRIGGER],
  ['MCB tripped.', GATE_REASONS.HAS_STRONG_TRIGGER],
  ['Continuity check.', GATE_REASONS.HAS_STRONG_TRIGGER],
])('forwards strong-trigger "%s" with reason=%s', (text, expectedReason) => {
  ...
});
```

### Weak-trigger-only blocks (was passing as `HAS_TRIGGER`, now blocks)

```javascript
test.each([
  // Weak trigger + ≤2 distinct content words → LOW_CONTENT block
  ['Going to the kitchen.', GATE_REASONS.LOW_CONTENT],
  ['I cracked an egg.', GATE_REASONS.LOW_CONTENT],
  ['I am done.', GATE_REASONS.LOW_CONTENT],
  ['Got an issue.', GATE_REASONS.LOW_CONTENT],
  ['Just a fuse.', GATE_REASONS.LOW_CONTENT],
  ['Loose change.', GATE_REASONS.LOW_CONTENT],
])('blocks weak-trigger-only "%s" with reason=%s', (text, expectedReason) => {
  ...
});
```

### Weak-trigger + digit still forwards via `HAS_DIGIT` (regression)

```javascript
test.each([
  ['Done with circuit 3.', GATE_REASONS.HAS_DIGIT],
  ['Add to circuit 4.', GATE_REASONS.HAS_DIGIT],
  ['Light circuit 7.', GATE_REASONS.HAS_DIGIT],
  ['Kitchen socket reading is 0.45.', GATE_REASONS.HAS_DIGIT],
])('forwards weak-trigger+digit "%s" with reason=%s', (text, expectedReason) => {
  ...
});
```

### Pre-existing `HAS_TRIGGER` test cases — update fixtures

Existing test at line ~43:

```javascript
['Yeah. So this is a circuit. I don't know what it does.', GATE_REASONS.HAS_TRIGGER],
['Could be for an old alarm.', GATE_REASONS.HAS_TRIGGER],
['Move to the next circuit.', GATE_REASONS.HAS_TRIGGER],
['Add an observation about the cooker.', GATE_REASONS.HAS_TRIGGER],
```

Update expected reasons:

- `"this is a circuit"` — only `circuit` (weak) → must fall through. Content
  words after stopword filter: yeah, so, circuit, don't, know — wait `don't`
  is in STOPWORDS? No, stopwords are: the, a, an, of, for, to, from, on, at,
  in, is, was, were, am, are, be, been, by, it, its, that, this, these,
  those, and, or, but, not, no, yes, uh, um, mm, so, just, well, now, then,
  there, here, whatever. So `don't` is content. Distinct: yeah, circuit,
  don't, know — that's 4 if we count contractions. With `'` in
  `WORD_REGEX = /[A-Za-z']+/g` — yes, `don't` is one word. So 4 distinct
  → forwards as `FALLBACK_FORWARD` not `HAS_TRIGGER`. Updated expectation.
- `"an old alarm"` — only `alarm` (weak). Stopwords: an. Distinct: could,
  be, old, alarm = 4 → `FALLBACK_FORWARD`. Updated.
- `"Move to the next circuit"` — `move`, `next`, `circuit` all weak.
  Stopwords: to, the. Distinct: move, next, circuit = 3 → `FALLBACK_FORWARD`.
  Updated.
- `"Add an observation about the cooker"` — `add` weak, `observation`
  STRONG, `cooker` weak. → `HAS_STRONG_TRIGGER` (because `observation` is
  strong). Updated.

The four lines above all need their expected reasons updated. None of
them should change from forward→block, but their forward reasons shift.

### Telemetry-stability check

```javascript
test('HAS_TRIGGER reason value is still exported for telemetry back-compat', () => {
  expect(GATE_REASONS.HAS_TRIGGER).toBe('has_trigger');
});
test('new HAS_STRONG_TRIGGER reason is exported', () => {
  expect(GATE_REASONS.HAS_STRONG_TRIGGER).toBe('has_strong_trigger');
});
```

## Rollout

1. Edit `pre-llm-gate.js`
2. Update `pre-llm-gate.test.js`
3. `npm test --testPathPattern="pre-llm-gate"` → ensure green
4. `npm test` → full suite for safety
5. Single commit
6. Push to main → CI tests → CI deploys to ECS (~15-20 min)
7. Observe `voice_latency.gate_blocked` count in CloudWatch for 24h
   - Expect: rate goes from ~7 / 24h to ~50-300 / 24h (production
     chitchat is more frequent than the artificial harness data)
   - Reason distribution: `low_content` should now dominate; the new
     fixture set has `low_content` catching most weak-trigger-alone
     transcripts
8. Reversibility: `VOICE_PRE_LLM_GATE=false` on task def disables the
   gate entirely (existing kill switch, untouched)

### Risk analysis

| Risk | Likelihood | Mitigation |
|---|---|---|
| Real observation blocked because the damage word is alone without a digit or strong trigger | Low — inspectors typically pair the damage with a circuit/location reference which keeps content-word count ≥3 → `FALLBACK_FORWARD` | Conservative `MIN_DISTINCT_CONTENT_WORDS = 3` retained; real observations are full sentences, not single words |
| Edge case: "kitchen socket loose connection" — three content words but no strong trigger or digit | Low — falls through to `FALLBACK_FORWARD` (3 distinct content words) | Forwards as expected; not a regression |
| Inspector says short canonical answer outside an ask context that no longer forwards | Very low — answers always travel with `hasPendingAsk: true` bypass | None needed; bypass is unchanged |
| Production gate-blocked rate spikes much higher than expected (e.g. drops a real reading category) | Low — measurable directly via `gate_blocked` reason histogram | Roll back via `VOICE_PRE_LLM_GATE=false` on task-def env (existing kill switch); investigate before re-shipping |
| `HAS_TRIGGER` reason disappears from telemetry, breaking a dashboard | Low — keeping the value in the enum is the explicit hedge | `HAS_TRIGGER` value retained; queries continue to compile, just rarely emit |

### Expected production impact

- Sonnet turn count: roughly -15-25% in field-test sessions where the
  inspector is also having conversations / moving rooms / making small
  talk. Cost cut proportional.
- Inspector-perceived experience: identical for substantive utterances
  (anything with a digit or a strong trigger forwards same as today).
- Chitchat pause: less likely to trigger because the gate catches the
  chitchat earlier — counter doesn't increment if the transcript was
  never forwarded.

## Open questions

- Whether `bs` / `en` as strong should be tightened. They're 2-letter
  words that could appear in unrelated speech (e.g. "BS" as expletive
  or "EN route"). Real-world data: extremely rare in inspector
  transcripts outside the BS-EN-code-dictation context, especially
  with a number nearby. Risk of false-positive forward = at most 1
  Sonnet round per occurrence. Keeping as strong for simplicity.
- Whether `spare` should be strong. It's a state-change verb ("circuit
  3 is spare") that creates a designation. Real-world usage is almost
  always inspection-context. Keeping as strong.
- `confirm` and `correct` — argued to stay weak because the
  `hasPendingAsk` bypass already handles answers and outside that
  context they're chitchat. Open to reconsidering if field data shows
  inspector-initiated confirms.

## Sequencing

Ship this as **Task C** preceding the **Task A + Task B** (chime + iOS
gate) pair already in `todos-certmate.md`. Reasoning:

- Server-side change, smaller blast radius, ~1 h work + test sprint
- Telemetry visibility within hours
- The iOS chime + iOS-side gate work can inherit the strong/weak
  taxonomy from this commit — gives the chime trigger predicate a
  shared definition between iOS and server

After Task C ships and shows healthy telemetry for a week, proceed to
Task A + B.
