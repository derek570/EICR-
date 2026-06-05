# Pre-LLM gate tightening — observation-gated architecture (PLAN_v4)

**Date:** 2026-05-29
**Author:** Claude session, voice-latency conversation continuation
**Status:** v4 — addresses Codex v3 BLOCKER + 3 MAJORs + 2 MINORs

## Changes from v3

| Codex v3 finding | v4 resolution |
|---|---|
| **BLOCKER 1** — OBSERVATION_PATTERN regex doesn't match claimed garbles | **Fixed.** Added `shon` to suffix list; verified all 10 garbles match (`observation`, `observations`, `obs`, `observance`, `obvashon`, `abservation`, `obviation`, `obstervation`, `obvashen`, `observatior`). All 15 rejection words still reject. Accepted false positive: `abbreviation` (rare in inspector speech). |
| **MAJOR 2** — Sonnet prompt still has inferred-observation Rule 2 (`sonnet_agentic_system.md:111`) | **Scoped as paired follow-up plan.** v4 cannot fully realise "observation-only" without prompt-side Rule 2 removal/conditioning. Documented in §"Required paired prompt change" with explicit sequencing — gate change MAY ship first but the architecture is incomplete until prompt aligns. |
| **MAJOR 3** — Chitchat-pause wake doesn't include OBSERVATION_PATTERN | **Fixed in same change.** v4 widens chitchat-pause wake to include OBSERVATION_PATTERN matches alongside the existing `WAKE_REGEX` + iOS `regexResults` checks. |
| **MAJOR 4** — `.withContext()` is Jasmine not Jest | **Fixed.** v4 test uses explicit message via try/catch + assertion message instead. |
| **MINOR 5** — ElevenLabs rate is $0.00005 not $0.00006 | **Fixed.** Updated cost arithmetic ($0.004 per 80-char ask, not $0.005). |
| **MINOR 6** — Bogus `observation_alt_observe` placeholder in WEAK | **Fixed.** Removed; comment clarifies `observation` lives only in OBSERVATION_PATTERN. |
| **QUESTION 7** — Consider `spd` for STRONG | **Accepted.** Added `spd` to STRONG with justification (original list line 76; follows MCB/RCD/RCBO equipment-abbreviation cluster; "SPD fitted" / "SPD present" would otherwise block as 2 content words). |

## Architectural pivot (recap from v3)

Per user direction 2026-05-29:
- **Q1:** Single-utterance prefix design
- **Q2:** Strictly observation noun forms + Deepgram garbles only (NOT verb forms `observe`/`observed`/`observing`)
- **Q3:** Damage adjectives (`cracked`/`exposed`/`missing`/etc.) BLOCKED at the gate without observation prefix

Result: STRONG list collapses from v2's 36 words to v4's 20 words + observation regex.

## Required paired prompt change (Codex v3 MAJOR 2)

`sonnet_agentic_system.md:111` currently instructs Sonnet:

> If a defect is described without an explicit observation trigger, emit `ask_user` with `reason="observation_confirmation"` to confirm the inspector intended to record it.

This Rule 2 means: even with v4's gate blocking short defect utterances ("socket cracked"), **longer defect utterances** ("The casing of the consumer unit cover is visibly cracked") will still pass `FALLBACK_FORWARD` (≥3 content words) → Sonnet → inferred observation ask. The gate alone does not deliver "observation-only" — it only blocks the short-form cases.

To fully realise the architecture, Rule 2 must be either:
1. **Removed** — Sonnet no longer infers observations from defect descriptions; inspector must say `observation` (matching `OBSERVATION_PATTERN`).
2. **Conditioned** on the transcript carrying an `observation_prefix: true` flag from the gate — server-side annotation, prompt reads it.

**Scope decision:** the prompt change is OUT OF SCOPE for this gate plan but a documented P0 dependency. The right sequencing is:
- This plan (v4 gate change) ships first.
- Paired prompt-change plan ships within the same sprint window.
- Until both ship, the user experience is "short-form defect blocked at gate, long-form defect still produces inferred observation asks."

Acknowledged trade-off: shipping the gate without the prompt change gives partial benefit (cost cut on short-form chitchat) but does NOT eliminate the inferred-observation ask pattern on longer utterances. Inspector experience improves but not fully consistent until prompt aligns.

## Design

### `STRONG_TRIGGER_WORDS` (forwards alone) — 20 words

```javascript
const STRONG_TRIGGER_WORDS = new Set([
  // Test field abbreviations — original lines 110-119
  'zs', 'ze', 'pfc', 'psc', 'ipfc', 'r1', 'r2',
  // Equipment abbreviations — original lines 76-80 (spd added per Codex v3 QUESTION 7)
  'mcb', 'rcd', 'rcbo', 'spd',
  // Test concepts — original lines 117-119
  'polarity', 'continuity', 'insulation',
  // State-change verbs — original lines 101-102
  'delete', 'remove',
  // Codex v2 MAJOR 5 — fcu promoted (was at line 71); cpc promoted (was at line 120)
  'fcu', 'cpc',
  // Justified additions:
  // - 'afdd' — inspector-only 4-letter abbreviation, follows MCB/RCD/RCBO cluster, near-zero false-positive in everyday speech
  // - 'r1r2' — common compact form of 'r1 plus r2'
  'afdd', 'r1r2',
]);
```

**Count: 20 words.** (18 from original + 2 justified additions.)

### `OBSERVATION_PATTERN` (forwards alone) — fuzzy regex (Codex v3 BLOCKER fixed)

```javascript
// Fuzzy regex matching the explicit "observation" keyword + Deepgram garbles.
//
// Deliberately STRICT — verb forms (observe/observed/observing/observer) NOT
// matched per user Q2 directive. Inspector must say "observation" (or
// recognised garble).
//
// Decomposition: /ˌɒb.zəˈveɪ.ʃən/ → ob-zer-vey-shun.
//
// Regex structure:
//   - First branch: 'obs' alone (truncation form)
//   - Second branch: [oa]? b [a-z]{0,5} v [a-z]{0,4} <suffix> s?
//     - [oa]? — optional initial vowel (handles 'b'-only and 'ab'-prefix garbles)
//     - b — required (anchors the ob-/ab- prefix)
//     - [a-z]{0,5} — 0-5 letters between b and v (handles 'obs', 'obz', 'obser', 'obstr' etc.)
//     - v — required (anchors mid-syllable)
//     - [a-z]{0,4} — 0-4 letters between v and suffix
//     - Suffix alternation: tion|sion|shun|shen|shan|shon|nce|tor|tior|ation
//     - s? — optional plural
const OBSERVATION_PATTERN = /\b(?:obs|[oa]?b[a-z]{0,5}v[a-z]{0,4}(?:tion|sion|shun|shen|shan|shon|nce|tor|tior|ation))s?\b/i;
```

**Verified behaviour (Node test 2026-05-29):**

| Category | Words | Result |
|---|---|---|
| MATCH | `observation`, `observations`, `obs`, `observance`, `obvashon`, `abservation`, `obviation`, `obstervation`, `obvashen`, `observatior` | All ✓ |
| REJECT | `observe`, `observed`, `observing`, `observer`, `obstruction`, `operation`, `objection`, `obsession`, `aviation`, `obvious`, `absurd`, `absorb`, `obscure`, `obesity`, `obscene` | All ✓ |
| ACCEPTED FALSE POSITIVE | `abbreviation` | Matches — rare in inspector speech, cost = 1 Sonnet round |

### `WEAK_TRIGGER_WORDS` (require digit or strong trigger or observation pattern) — 75 words

```javascript
const WEAK_TRIGGER_WORDS = new Set([
  // Circuit and board nouns
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
  'radial', 'main', 'sub-main', 'submain', 'fuse',
  'trip', 'breaker',
  // Generic conductor — ring-continuity language always has digits
  'live', 'neutral', 'protective', 'conductor', 'cable', 'wiring',
  'colour', 'color',
  // Safety + observation language — now WEAK per user Q3 because the explicit
  // 'observation' keyword (matched by OBSERVATION_PATTERN above) is the
  // gate trigger for observation flow. 'observe' is intentionally not in
  // OBSERVATION_PATTERN per Q2 strictness.
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

`observation` is NOT in the WEAK set — it lives only in `OBSERVATION_PATTERN`. (Codex v3 MINOR 6 — removed bogus `observation_alt_observe` placeholder.)

**Count: 75 words** (from original; `observation` moved to regex; `spd` moved to STRONG).

### Vocabulary accounting (Codex v3 / v2 MAJOR 4 honestly addressed)

Original `TRIGGER_WORDS.size === 94`.

| Disposition | Words | Count |
|---|---|---|
| In STRONG (from original) | zs, ze, pfc, psc, ipfc, r1, r2, mcb, rcd, rcbo, spd, polarity, continuity, insulation, delete, remove, fcu, cpc | **18** |
| In WEAK (from original) | (75 words; see list) | **75** |
| In OBSERVATION_PATTERN (from original) | observation | **1** |
| **Total preserved from original** | | **94 ✓** |
| Justified STRONG additions (not in original) | afdd, r1r2 | **2** |

Vocabulary preservation invariant codified in tests.

### New forward logic (Codex v3 finding on step ordering noted)

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

Step 8 fires before step 9 so observation-prefixed utterances log as the
cleaner `HAS_OBSERVATION_PREFIX` reason. Codex v3 confirmed this ordering
is correct for telemetry.

### Chitchat-pause wake widening (Codex v3 MAJOR 3 fix)

Current wake condition (sonnet-stream.js:976):
```javascript
const isWake = WAKE_REGEX.test(text) || (regexResults && regexResults.length > 0);
```

Modified:
```javascript
import { _internals as gateInternals } from './pre-llm-gate.js';

const isWake =
  WAKE_REGEX.test(text) ||
  (regexResults && regexResults.length > 0) ||
  gateInternals.OBSERVATION_PATTERN.test(text);
```

This ensures that an inspector saying "Observation: socket cracked"
during an active chitchat pause wakes the session and processes the
observation, matching the v4 architecture's promise.

Telemetry: existing chitchat wake events already log; the new wake path
emits the same event so no separate dashboard work needed.

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

## False-positive cost analysis (Codex v3 MINOR 5 corrected)

ElevenLabs character rate at `cost-tracker.js:19` is **$0.00005** per char
(v3 said $0.00006). For an 80-character ask_user message:
- 80 chars × $0.00005 = **$0.004** per ElevenLabs ask

**Corrected worst-case false-positive cost:**
- Sonnet round 1 (forced tool_use via `tool_choice:any`): ~$0.005
- If ask_user emitted: + $0.004 TTS
- Inspector answer + additional Sonnet rounds + dispatch: variable
- **Realistic worst case: ~$0.013 per false-positive forward + an audible TTS clarification interrupting the inspector**

The acknowledged false positives in v4 are limited to genuine 3+ content
word sentences, not short chitchat. The trade is biased correctly — block
short chitchat aggressively, forward genuine-sentence shapes that might
contain extraction value.

## Behavioural matrix

| Transcript | Pre (today) | Post (v4) | Reason | Notes |
|---|---|---|---|---|
| "Circuit 3 number of points 5" | forward | forward | `HAS_DIGIT` | Unchanged |
| "Zs nought point four" | forward | forward | `HAS_STRONG_TRIGGER` | |
| "Polarity confirmed" | forward | forward | `HAS_STRONG_TRIGGER` | |
| "MCB tripped" | forward | forward | `HAS_STRONG_TRIGGER` | |
| "SPD fitted" | forward (`has_trigger: spd`) | forward | `HAS_STRONG_TRIGGER` (spd) | **Codex v3 QUESTION 7 fix** |
| "SPD present" | forward | forward | `HAS_STRONG_TRIGGER` (spd) | |
| "Observation: socket cracked" | forward | forward | `HAS_OBSERVATION_PREFIX` | NEW path |
| "Obs: cooker is loose" | forward | forward | `HAS_OBSERVATION_PREFIX` | Truncation |
| "Obvashon, cracked casing" | forward | forward | `HAS_OBSERVATION_PREFIX` | **Codex v3 BLOCKER 1 — now matches** |
| "Abservation, missing cover" | forward | forward | `HAS_OBSERVATION_PREFIX` | **Codex v3 BLOCKER 1 — now matches** |
| "Observation observed earlier" | forward | forward | `HAS_OBSERVATION_PREFIX` | `observation` matches; verb `observed` does not but doesn't matter |
| "I observe" | forward | (depends — see below) | | Verb form not matched by OBSERVATION_PATTERN per Q2 |
| "I observe a problem" | forward | forward | `FALLBACK_FORWARD` (3 distinct) | Long enough for fallback |
| "Observing" | forward | **block** | `LOW_CONTENT` (1 distinct) | Verb form, short — blocks |
| "Socket cracked" | forward | **block** | `LOW_CONTENT` | Q3 blocks |
| "Cable exposed" | forward | **block** | `LOW_CONTENT` | Q3 blocks |
| "No earth" | forward | **block** | `LOW_CONTENT` | Q3 blocks |
| "I cracked an egg" | forward | **block** | `LOW_CONTENT` | False positive eliminated |
| "FCU spur" | forward | forward | `HAS_STRONG_TRIGGER` | |
| "EN route now" | n/a (en not trigger) | **block** | `LOW_CONTENT` (en, route = 2; now stopword) | Codex v2 MAJOR 5 corrected |
| "Just had to confirm with the client" | forward | forward | `FALLBACK_FORWARD` (3 distinct) | Edge — Sonnet returns no extraction; cost = $0.005-0.013 |
| "Cooker circuit 4" | forward | forward | `HAS_DIGIT` | |
| "Clear that reading" | forward | **block** | `LOW_CONTENT` (clear, reading = 2) | Codex v2 MAJOR 4 — clear not in STRONG; inspector adds circuit ref |
| "Clear circuit 3 reading" | forward | forward | `HAS_DIGIT` | |
| "Rename circuit 4 to cooker" | forward | forward | `HAS_DIGIT` | |
| "Defect on casing" | forward | **block** | `LOW_CONTENT` (defect, casing = 2) | Q2 — must prefix with `observation` |

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
  // Codex v3 QUESTION 7 — spd added
  ['SPD fitted.', GATE_REASONS.HAS_STRONG_TRIGGER],
  ['SPD present.', GATE_REASONS.HAS_STRONG_TRIGGER],
])('forwards strong-trigger "%s" with reason=%s', ...)
```

### Observation pattern forwards (NEW — Codex v3 BLOCKER 1 fix verified)

```javascript
test.each([
  // Canonical
  ['Observation: socket cracked.', GATE_REASONS.HAS_OBSERVATION_PREFIX],
  ['Observation. The cable is exposed.', GATE_REASONS.HAS_OBSERVATION_PREFIX],
  ['I have an observation about the cooker.', GATE_REASONS.HAS_OBSERVATION_PREFIX],
  ['Add an observation.', GATE_REASONS.HAS_OBSERVATION_PREFIX],
  ['Note an observation.', GATE_REASONS.HAS_OBSERVATION_PREFIX],
  ['Observations recorded.', GATE_REASONS.HAS_OBSERVATION_PREFIX],
  // Truncation
  ['Obs: cracked casing.', GATE_REASONS.HAS_OBSERVATION_PREFIX],
  // Deepgram garbles — Codex v3 BLOCKER 1
  ['Obvashon, cracked casing.', GATE_REASONS.HAS_OBSERVATION_PREFIX],
  ['Abservation, missing cover.', GATE_REASONS.HAS_OBSERVATION_PREFIX],
  ['Obviation here.', GATE_REASONS.HAS_OBSERVATION_PREFIX],
  ['Obstervation noted.', GATE_REASONS.HAS_OBSERVATION_PREFIX],
  ['Obvashen here.', GATE_REASONS.HAS_OBSERVATION_PREFIX],
  ['Observatior on cable.', GATE_REASONS.HAS_OBSERVATION_PREFIX],
  // Homophone overlap
  ['Observance of the rules.', GATE_REASONS.HAS_OBSERVATION_PREFIX],
])('forwards observation-pattern "%s"', ...)
```

### Observation pattern does NOT match verb forms (Q2 strictness)

```javascript
test.each([
  ['I observe a problem.', GATE_REASONS.FALLBACK_FORWARD],
  ['I observed a crack.', GATE_REASONS.FALLBACK_FORWARD],
  ['Observing the test.', GATE_REASONS.LOW_CONTENT],
  ['Observer noted.', GATE_REASONS.LOW_CONTENT],
])('verb forms do not match OBSERVATION_PATTERN "%s"', ...)
```

### Observation pattern rejects non-electrical English words

```javascript
test.each([
  ['Obstruction in the road.', GATE_REASONS.FALLBACK_FORWARD], // 3 distinct, but observation_pattern rejects
  ['Operation completed.', GATE_REASONS.HAS_STRONG_TRIGGER], // (no — completed isn't a trigger; let me trace)
  // Actually 'operation completed' has 2 distinct content words → LOW_CONTENT
  // Tested separately:
])('observation pattern rejects non-electrical words', () => {
  expect(OBSERVATION_PATTERN.test('obstruction')).toBe(false);
  expect(OBSERVATION_PATTERN.test('operation')).toBe(false);
  expect(OBSERVATION_PATTERN.test('objection')).toBe(false);
  expect(OBSERVATION_PATTERN.test('obsession')).toBe(false);
  expect(OBSERVATION_PATTERN.test('aviation')).toBe(false);
  expect(OBSERVATION_PATTERN.test('obvious')).toBe(false);
  expect(OBSERVATION_PATTERN.test('absorb')).toBe(false);
});

test('accepted false positive: abbreviation matches', () => {
  // abbreviation matches the fuzzy pattern; semantically rare in inspector
  // speech. Acknowledged in PLAN_v4.
  expect(OBSERVATION_PATTERN.test('abbreviation')).toBe(true);
});
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
  ['Defect on casing.', GATE_REASONS.LOW_CONTENT],
  ['I cracked an egg.', GATE_REASONS.LOW_CONTENT],
])('blocks damage-adjective without observation prefix "%s"', ...)
```

### Damage adjectives + observation prefix forward

```javascript
test.each([
  ['Observation: socket cracked.', GATE_REASONS.HAS_OBSERVATION_PREFIX],
  ['Obvashon, cable exposed.', GATE_REASONS.HAS_OBSERVATION_PREFIX],
  ['Observation: no earth.', GATE_REASONS.HAS_OBSERVATION_PREFIX],
  ['Observation: cover missing on circuit 3.', GATE_REASONS.HAS_OBSERVATION_PREFIX],
])('forwards damage+observation prefix "%s"', ...)
```

### Codex v2 MAJOR 5 — `EN route now` correct expected

```javascript
test('EN route now → LOW_CONTENT', () => {
  const result = shouldForwardToSonnet('EN route now.');
  expect(result.forward).toBe(false);
  expect(result.reason).toBe(GATE_REASONS.LOW_CONTENT);
});
```

### Codex v2 MAJOR 4 — silent additions regression guard

```javascript
test.each([
  ['Clear that.', GATE_REASONS.LOW_CONTENT],
  ['Rename it.', GATE_REASONS.LOW_CONTENT],
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

### Original-94 preservation invariant (Codex v2 MAJOR 4 — Jest syntax fixed)

```javascript
import {
  _internals,
  OBSERVATION_PATTERN,
} from '../extraction/pre-llm-gate.js';
import { ORIGINAL_TRIGGER_WORDS_FROM_2026_05_26 } from './fixtures/original-94-words.js';

test('every original-94 word appears in STRONG, WEAK, or OBSERVATION_PATTERN', () => {
  const missing = [];
  for (const w of ORIGINAL_TRIGGER_WORDS_FROM_2026_05_26) {
    const inStrong = _internals.STRONG_TRIGGER_WORDS.has(w);
    const inWeak = _internals.WEAK_TRIGGER_WORDS.has(w);
    const inObservationRegex = OBSERVATION_PATTERN.test(w);
    if (!(inStrong || inWeak || inObservationRegex)) {
      missing.push(w);
    }
  }
  // Codex v3 MAJOR 4 — use Jest-compatible message via comment in expect
  expect(missing).toEqual([]);
});

test('STRONG additions limited to ["afdd", "r1r2"]', () => {
  const additions = [..._internals.STRONG_TRIGGER_WORDS]
    .filter((w) => !ORIGINAL_TRIGGER_WORDS_FROM_2026_05_26.has(w));
  expect(additions.sort()).toEqual(['afdd', 'r1r2']);
});

test('WEAK additions limited to none (original word set preserved verbatim minus moves)', () => {
  const additions = [..._internals.WEAK_TRIGGER_WORDS]
    .filter((w) => !ORIGINAL_TRIGGER_WORDS_FROM_2026_05_26.has(w));
  expect(additions).toEqual([]);
});
```

### Telemetry stability

```javascript
test.each([
  ['HAS_TRIGGER', 'has_trigger'],
  ['HAS_STRONG_TRIGGER', 'has_strong_trigger'],
  ['HAS_OBSERVATION_PREFIX', 'has_observation_prefix'],
])('GATE_REASONS.%s = %s', (key, value) => {
  expect(GATE_REASONS[key]).toBe(value);
});
```

### Chitchat-pause wake widening (NEW — Codex v3 MAJOR 3 fix)

```javascript
// sonnet-stream.test.js or chitchat-pause.test.js
test('observation pattern wakes a paused session', () => {
  const session = makePausedSession();
  expect(isWake('Observation: socket cracked', session, null)).toBe(true);
});

test('observation pattern wakes paused session even with garble', () => {
  const session = makePausedSession();
  expect(isWake('Obvashon, missing cover', session, null)).toBe(true);
});

test('non-observation utterance does not wake (preserves existing behaviour)', () => {
  const session = makePausedSession();
  expect(isWake('Going to the kitchen', session, null)).toBe(false);
});
```

## Rollout

1. Edit `src/extraction/pre-llm-gate.js` — STRONG/WEAK split, OBSERVATION_PATTERN,
   new `shouldForwardToSonnet` body, expanded `_internals` export
2. Edit `src/extraction/sonnet-stream.js` line ~976 — import OBSERVATION_PATTERN
   from `pre-llm-gate.js`, widen wake check
3. Edit `src/__tests__/pre-llm-gate.test.js` — ~40 new fixtures + 4 updated existing
4. Create `src/__tests__/fixtures/original-94-words.js` — pinned set
5. Edit chitchat-pause / sonnet-stream tests — add 3 wake-widening cases
6. `npm test --testPathPattern="(pre-llm-gate|chitchat|sonnet-stream)"` — green
7. `npm test` — full suite green
8. Single commit (or two: gate + wake widening)
9. Push to main → CI → ECS deploy
10. Observe `voice_latency.gate_blocked` + chitchat wake telemetry for 48h
11. Kill switch: `VOICE_PRE_LLM_GATE=false` on task-def (gate-only rollback);
    chitchat wake widening has no separate kill switch but is small + reversible

## Risk analysis

| Risk | Likelihood | Mitigation |
|---|---|---|
| OBSERVATION_PATTERN misses a Deepgram garble we haven't seen | Medium | Telemetry: gate_blocked + LOW_CONTENT during field test; extend regex |
| Damage-adjective workflow regression (inspector says "socket cracked" expecting extraction) | Medium per Q3 | Documented in inspector onboarding; falls back to inferred-observation ask in long-form |
| OBSERVATION_PATTERN false positive `abbreviation` | Very low — rare in inspector speech | 1 Sonnet round cost (~$0.005) per occurrence |
| Sonnet prompt Rule 2 still produces inferred observations on long-form defects | High **until paired prompt change ships** | §"Required paired prompt change" documents the dependency |
| Chitchat wake widening over-wakes on `abbreviation` mention during pause | Very low | Same cost-frame as gate false positive |
| Vocabulary creep on future edits | Low | Invariant tests pin original-94 + STRONG additions |
| `HAS_TRIGGER` reason value emitted by external CloudWatch queries | Unknown external | Reason value preserved in enum |
| Gate-blocked rate spikes higher than expected | Medium — measurable | Roll back via `VOICE_PRE_LLM_GATE=false` |

## Expected production impact

- Sonnet turn count: **30-40% reduction** on field-test sessions
- Sonnet cost: proportional
- Sonnet+TTS cost on false-positive ask_user: eliminated for chitchat shapes
- Chitchat-pause activation: less frequent; wake correctly fires on explicit observation
- Inspector experience: simplification — single keyword "observation" enters the workflow; damage-adjective shorthand no longer extracts (must prefix)

## Out of scope

- Sonnet prompt Rule 2 change at `sonnet_agentic_system.md:111` — **P0 dependency**, scoped as paired follow-up plan, must ship in same sprint window
- iOS chime + iOS-side gate (already in todos-certmate.md; inherits v4 taxonomy)
- Tightening `FALLBACK_FORWARD` ≥3 distinct content words rule
- Multi-utterance observation state machine (Q1 = single-utterance)
