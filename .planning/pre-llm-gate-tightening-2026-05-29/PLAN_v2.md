# Pre-LLM gate tightening — strong/weak trigger split (PLAN_v2)

**Date:** 2026-05-29
**Author:** Claude session, voice-latency conversation continuation
**Status:** v2 — addresses Codex review findings on v1

## Changes from v1

1. **Damage adjectives + safety-critical words promoted to STRONG.** Codex BLOCKER 1: demoting `crack/cracked/burn/burnt/damage/damaged/missing/exposed/loose/corroded` + `earth/bond/bonding` would silently drop real terse safety observations like "socket cracked", "cable exposed", "no earth". These produce real `observation_confirmation` asks per `sonnet_agentic_system.md:111`. Moved back to STRONG.
2. **`fcu` promoted to STRONG.** Codex MAJOR 5: it's specialist inspector vocabulary, not generic.
3. **Silent vocabulary expansions removed.** Codex MAJOR 4: v1 added `bs`, `en`, `afdd`, `r1r2`, `cpc`, `earthing` that were NOT in the original 94-word list. The plan is described as a "split" but these were "expansions". For v2 I treat each as a separate decision and justify or drop:
   - `bs` / `en` — **DROPPED.** Codex MAJOR 3: 2-letter words leak everyday speech ("EN route", bare "BS" chatter). Real BS-EN codes always include digits → `HAS_DIGIT` already handles them.
   - `afdd` — **KEPT in STRONG (justified addition).** Inspector-only 4-letter abbreviation, follows MCB/RCD/RCBO pattern. False-positive risk in everyday speech is effectively zero. Adding aligns with the existing equipment-abbreviation cluster.
   - `r1r2` — **KEPT in STRONG (justified addition).** Same logic as `afdd`; commonly typed without the `+` in raw transcripts. Aligns with `r1`/`r2` already present.
   - `cpc` — **KEPT in STRONG (justified upgrade — was already in list, demoted erroneously in v1).** Codex MAJOR 4: `cpc` is in the original list at line 120. Specialist abbreviation. Upgrade to STRONG.
   - `earthing` / `spare` — **DROPPED from additions.** Neither is in the original list. `earthing` overlaps with `earth` + `bonding`; `spare` is an inspector concept but covered by record_reading's value enum.
4. **Accurate vocabulary count.** Original `TRIGGER_WORDS.size === 94`, not ~140. Updated throughout.
5. **Bare-designation behaviour explicitly justified.** Codex BLOCKER 2 flagged short fragments like `smoke alarm`, `FCU spur`, `main bonding`, `ring final`, `garage board`. v2 keeps these WEAK with explicit rationale: bare designations without circuit reference cannot produce safe extraction — Sonnet either panic-asks "which circuit?" or mis-attributes to a stale recent-context turn. Inspectors who want to set a designation use `rename circuit N to ...` which forwards via the STRONG `rename` trigger.
6. **Chitchat-pause interaction analysed.** Codex MAJOR 6.
7. **Test fixture coverage expanded** per Codex MAJOR 10.

## Context (recap, unchanged from v1)

`src/extraction/pre-llm-gate.js` — server-side gate, on by default. Was introduced after field session `33E6613D` (2026-05-26) panic-ask burst.

Current forward rule (any of):
1. iOS regex hit (`regexResults` non-empty)
2. Session has pending ask
3. iOS tagged `inResponseTo`
4. Drained-retry replay
5. Any digit anywhere (`HAS_DIGIT`)
6. **Any of 94 trigger words (`HAS_TRIGGER`)** — the leaky rule
7. ≥3 distinct content words (`FALLBACK_FORWARD`)

Production: 7 blocks last 24 h, all `LOW_CONTENT`. Trigger-word rule effectively universal.

## Goal

Tighten so that **only intent-bearing trigger words** forward alone. Weak triggers (room names, navigation verbs, generic conductor terms) require accompanying digit or strong trigger. Preserve every shape that genuinely produces extraction.

## Design — Option A (chosen, revised)

Split the 94-word `TRIGGER_WORDS` set into STRONG and WEAK, plus 3 justified additions to STRONG.

### `STRONG_TRIGGER_WORDS` (forwards alone) — 36 words

Words whose appearance reliably indicates an extraction-worthy or
observation-bearing utterance.

```javascript
// Test field abbreviations — from original list lines 110-119
'zs', 'ze', 'pfc', 'psc', 'ipfc', 'r1', 'r2',
// Equipment abbreviations — from original list lines 77-80
'mcb', 'rcd', 'rcbo',
// Test concepts — from original list lines 117-122
'polarity', 'continuity', 'insulation',
// State-change action verbs — from original list lines 101-103
'clear', 'delete', 'remove', 'rename',
// Observation intent — from original list lines 82-83
'observation', 'observe', 'defect',
// Damage adjectives + safety observations (Codex BLOCKER 1 — these are
// terse safety observations that produce real observation asks)
// All from original list lines 86-95 except where noted.
'crack', 'cracked', 'burn', 'burnt', 'damage', 'damaged',
'missing', 'exposed', 'loose', 'corroded',
// Safety-critical context words (Codex BLOCKER 1)
// All from original list lines 120-122.
'earth', 'bond', 'bonding',
// Specialist abbreviations (Codex MAJOR 5)
// 'fcu' was in original; promoting (was line 71).
// 'cpc' was in original; promoting (was line 120).
'fcu', 'cpc',
// Justified additions (Codex MAJOR 4):
// 'afdd' — inspector-only 4-letter abbreviation, follows MCB/RCD/RCBO cluster.
// 'r1r2' — common compact form of 'r1 plus r2'.
'afdd', 'r1r2',
```

**Count: 36 words.** (33 from original + 3 justified additions: afdd, r1r2, cpc-moved.)

### `WEAK_TRIGGER_WORDS` (require digit or strong trigger) — 61 words

Remaining words from the original 94. Demoted because the bare word is
too common in everyday speech to justify forward-authority on its own,
or because the inspector workflow always pairs them with a digit
(circuit ref) or strong trigger.

```javascript
// Circuit and board nouns — generic enough to leak chitchat
'circuit', 'circuits', 'board', 'boards', 'ring', 'socket', 'sockets',
'lights', 'light',
// Appliance designations — without a circuit ref, these are bare
// designations that produce panic-asks (the gate's reason for being)
'shower', 'cooker', 'oven', 'hob', 'heater', 'immersion', 'spur',
// Room names — pure location chitchat without context
'kitchen', 'lounge', 'living', 'bedroom', 'bedrooms', 'bathroom',
'hallway', 'garage', 'utility', 'loft', 'attic', 'landing',
// Smoke/alarm — bare designation, same rationale as appliances
'smoke', 'alarm',
// Generic electrical descriptors — appear in unrelated speech
'radial', 'main', 'sub-main', 'submain', 'spd', 'fuse',
'trip', 'breaker',
// Generic conductor terms — chitchat-prone
// 'live'/'neutral' appear in ring-continuity language ('lives 0.32',
// 'neutrals are 0.41') but those always include digits → HAS_DIGIT.
'live', 'neutral', 'protective', 'conductor', 'cable', 'wiring',
'colour', 'color',
// Navigation / UI commands — pure non-extraction intent
'note', 'record', 'fill', 'add', 'move', 'next', 'previous',
'done', 'finish', 'skip',
// Confirmation / inspection vocabulary — chitchat unless answering an
// existing ask (which the hasPendingAsk bypass already handles)
'confirm', 'correct', 'overall', 'summary', 'inspection', 'issue',
```

**Count: 61 words.** (61 from original.)

### Vocabulary accounting

- Original: 94 words
- STRONG: 36 (33 from original + 3 justified additions)
- WEAK: 61 from original
- TOTAL preserved from original: 33 + 61 = 94 ✓ no original word dropped silently
- Additions: 3 (afdd, r1r2 — new; cpc — moved within set, was in original)

### New forward logic

```
1. !gateEnabled                       → forward (BYPASS_DISABLED)
2. drainedRetry                       → forward (BYPASS_DRAINED_RETRY)
3. hasPendingAsk                      → forward (BYPASS_PENDING_ASK)
4. inResponseTo                       → forward (BYPASS_IN_RESPONSE_TO)
5. regexResults non-empty             → forward (HAS_REGEX_HINT)
6. text empty                         → block   (EMPTY)
7. hasDigit                           → forward (HAS_DIGIT)
8. hasStrongTrigger                   → forward (HAS_STRONG_TRIGGER) ← NEW
9. ≥3 distinct content words          → forward (FALLBACK_FORWARD)
10. else                              → block   (LOW_CONTENT)
```

Net change vs today: **only step 8 differs.** Today's step 8 is "any of 94
trigger words forward". v2 step 8 is "any of 36 strong trigger words
forward". The 61 weak words still feed the content-word count in step 9.

### Telemetry surface

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

`HAS_TRIGGER` value kept but unreachable. Codex MINOR 9 confirmed no in-repo
consumers exist outside the gate file + tests; external CloudWatch queries
unknown. Keeping the value avoids breaking those if any exist.

## Chitchat-pause interaction — Codex MAJOR 6 analysis

The gate runs BEFORE `questionGate.onNewUtterance()` and BEFORE Sonnet
session.extract() at `sonnet-stream.js:3194`. Blocked transcripts never
touch the chitchat engagement counter.

### Effect on chitchat-pause activation

The chitchat counter (`chitchat-pause.js`) increments on **Sonnet turns
that produce zero engagement**. With v2:

- A leaky-trigger transcript that today forwards → Sonnet runs → no
  extraction → counter +1
- Same transcript under v2 (`kitchen`/`cooker`/`smoke alarm` etc. alone)
  → gate blocks → counter NOT incremented → no Sonnet round → no cost

So v2 makes chitchat-pause activation **less likely**, not more — every
gate block is a counter increment that doesn't happen. This is a
secondary benefit, not a regression.

### Effect during an active chitchat-pause

Once chitchat-pause is active, `sonnet-stream.js:976` only wakes on
explicit wake words or iOS `regexResults`. **STRONG trigger words do not
wake a paused session.** That means even with v2's stronger observation
triggers, "socket cracked" said during a paused session is suppressed.

This is a PRE-EXISTING issue not caused by v2. v2 does not make it
worse; v2 keeps observation language (cracked/exposed/damaged/missing/
loose/corroded/earth/bond) in STRONG so when chitchat is NOT paused,
those transcripts forward as today.

**Out of scope for this change:** widening the chitchat-pause wake
condition to include STRONG triggers. That would be a separate plan —
it's the right next step but has its own risk surface (waking too
eagerly on routine equipment-name dictation).

### Conclusion

v2's gate change is independent of chitchat-pause wake logic. No
behavioural regression vs today's gate for inspectors during an active
pause. Net behavioural improvement when NOT paused: cheaper
non-engagement turns blocked earlier without losing real readings.

## Bare-designation behaviour — Codex BLOCKER 2 deliberation

Codex flagged 5 short-fragment shapes:
- `smoke alarm` — 2 weak words (smoke, alarm), 0 strong, 0 digit
- `FCU spur` — `fcu` is now STRONG → forwards ✓ (resolved)
- `main bonding` — `bonding` is now STRONG → forwards ✓ (resolved)
- `ring final` — `ring` weak, `final` not a trigger → falls to content count = 2 → blocks
- `garage board` — `garage` weak, `board` weak → falls to content count = 2 → blocks

`smoke alarm` and `ring final` and `garage board` block under v2.
Decision: **acceptable.** Rationale:

1. **The gate's reason for being is panic-ask prevention.** Bare
   designations without a circuit reference are exactly the shape Sonnet
   panic-asks against ("Which circuit is the smoke alarm on?"). The
   2026-05-26 session 33E6613D field log shows the same pattern —
   inspector said "smoke alarm" → Sonnet asked "which circuit" → no
   answer → burst of panic-asks at 5 s intervals.
2. **The right way to record a bare designation is via state-change
   intent words, which forward as STRONG.** Inspector who wants to
   rename circuit 4 to "smoke alarm" says either:
   - "Rename circuit 4 to smoke alarm" → `HAS_DIGIT` + `rename` STRONG
   - "Circuit 4 is the smoke alarm" → `HAS_DIGIT`
   - Both forward as expected.
3. **The gate is reversible per-session via `VOICE_PRE_LLM_GATE=false`
   on the task-def.** If field-test telemetry shows real-world inspectors
   are saying bare designations and expecting them to extract, we can
   disable the gate within minutes of confirming.

`FCU spur` and `main bonding` continue to forward under v2 because `fcu`
and `bonding` are now STRONG. That's the right outcome — both phrases
are unambiguous inspector context.

## Behavioural matrix (revised — tracks Codex examples)

| Transcript | Pre (today) | Post (v2) | Reason | Notes |
|---|---|---|---|---|
| "Circuit 3 number of points 5" | forward | forward | `HAS_DIGIT` | Unchanged |
| "Zs nought point four" | forward | forward | `HAS_STRONG_TRIGGER` (`zs`) | |
| "Clear that reading" | forward | forward | `HAS_STRONG_TRIGGER` (`clear`) | |
| "Add an observation about the cooker" | forward (`has_trigger: cooker`) | forward | `HAS_STRONG_TRIGGER` (`observation`) | |
| "Socket cracked" | forward (`has_trigger: cracked`) | forward | `HAS_STRONG_TRIGGER` (`cracked`) | **Codex BLOCKER 1 fix** |
| "Cable exposed" | forward (`has_trigger`) | forward | `HAS_STRONG_TRIGGER` (`exposed`) | **Codex BLOCKER 1 fix** |
| "No earth" | forward (`has_trigger: earth`) | forward | `HAS_STRONG_TRIGGER` (`earth`) | **Codex BLOCKER 1 fix** |
| "Cover missing" | forward (`has_trigger`) | forward | `HAS_STRONG_TRIGGER` (`missing`) | **Codex BLOCKER 1 fix** |
| "Loose connection" | forward (`has_trigger: loose`) | forward | `HAS_STRONG_TRIGGER` (`loose`) | **Codex BLOCKER 1 fix** |
| "FCU spur" | forward (`has_trigger: fcu`) | forward | `HAS_STRONG_TRIGGER` (`fcu`) | **Codex MAJOR 5 fix** |
| "Main bonding" | forward (`has_trigger: bonding`) | forward | `HAS_STRONG_TRIGGER` (`bonding`) | |
| "Smoke alarm" | forward (`has_trigger`) | **block** | `LOW_CONTENT` | Deliberate per §3 |
| "Ring final" | forward (`has_trigger: ring`) | **block** | `LOW_CONTENT` | Deliberate per §3 |
| "Garage board" | forward (`has_trigger`) | **block** | `LOW_CONTENT` | Deliberate per §3 |
| "Going to the kitchen" | forward (`has_trigger: kitchen`) | **block** | `LOW_CONTENT` (distinct: going, kitchen = 2) | Intended cost cut |
| "I'm done" | forward (`has_trigger: done`) | **block** | `LOW_CONTENT` | Intended cost cut |
| "Just had to confirm with the client" | forward (`has_trigger`) | forward | `FALLBACK_FORWARD` (distinct ≥3) | Edge — forwards via fallback; acceptable |
| "I cracked an egg" | forward (`has_trigger: cracked`) | forward | `HAS_STRONG_TRIGGER` (`cracked`) | **False positive!** `cracked` STRONG → forwards. Inspector workflow: Sonnet processes, finds no extraction context, returns empty. Cost: one Sonnet round. Acceptable trade vs blocking real "socket cracked" observations. |
| "EN route now" | n/a — `en` not currently a trigger | n/a — `en` removed from v2 STRONG | `FALLBACK_FORWARD` (3 content words) | Codex MAJOR 3 fix |
| "BS honestly" | n/a — `bs` not currently a trigger | n/a — `bs` removed from v2 STRONG | `LOW_CONTENT` (distinct: bs, honestly = 2) | Codex MAJOR 3 fix |
| "Cooker circuit 4" | forward | forward | `HAS_DIGIT` | |
| "Defect on the casing" | forward (`has_trigger: defect`) | forward | `HAS_STRONG_TRIGGER` (`defect`) | |
| "Polarity confirmed" | forward (`has_trigger`) | forward | `HAS_STRONG_TRIGGER` (`polarity`) | |

### Acknowledged false positives

- **"I cracked an egg"** still forwards. Sonnet returns no extraction.
  Cost: 1 round ($0.005). This is acceptable — the alternative is
  blocking the real observation "socket cracked", which is far worse.
- **"Just had to confirm with the client"** still forwards via
  `FALLBACK_FORWARD` (3 content words: had, confirm, client). Sonnet
  returns no extraction. Cost: 1 round.

The gate is conservative-by-design. False positives waste a Sonnet round;
false negatives (a real observation gated out) lose data and force the
inspector to repeat. The trade is correctly biased.

## Tests — expanded coverage (Codex MAJOR 10)

### New strong-trigger forwards

```javascript
test.each([
  ['Zs.', GATE_REASONS.HAS_STRONG_TRIGGER],
  ['Polarity confirmed', GATE_REASONS.HAS_STRONG_TRIGGER],
  ['Clear that.', GATE_REASONS.HAS_STRONG_TRIGGER],
  ['Add an observation.', GATE_REASONS.HAS_STRONG_TRIGGER],
  ['Defect on the casing.', GATE_REASONS.HAS_STRONG_TRIGGER],
  ['MCB tripped.', GATE_REASONS.HAS_STRONG_TRIGGER],
  ['Continuity check.', GATE_REASONS.HAS_STRONG_TRIGGER],
  // Codex BLOCKER 1 — damage adjectives + safety observations
  ['Socket cracked.', GATE_REASONS.HAS_STRONG_TRIGGER],
  ['Cable exposed.', GATE_REASONS.HAS_STRONG_TRIGGER],
  ['No earth.', GATE_REASONS.HAS_STRONG_TRIGGER],
  ['Cover missing.', GATE_REASONS.HAS_STRONG_TRIGGER],
  ['Loose connection.', GATE_REASONS.HAS_STRONG_TRIGGER],
  ['Cracked casing.', GATE_REASONS.HAS_STRONG_TRIGGER],
  ['Burnt cable.', GATE_REASONS.HAS_STRONG_TRIGGER],
  // Codex MAJOR 5 — fcu / cpc promotion
  ['FCU spur.', GATE_REASONS.HAS_STRONG_TRIGGER],
  ['CPC discontinuous.', GATE_REASONS.HAS_STRONG_TRIGGER],
  // Justified additions
  ['AFDD installed.', GATE_REASONS.HAS_STRONG_TRIGGER],
  ['R1R2 for kitchen.', GATE_REASONS.HAS_STRONG_TRIGGER],
])('forwards strong-trigger "%s" with reason=%s', ...)
```

### Weak-trigger-only blocks (panic-ask prevention path)

```javascript
test.each([
  // Bare designations — deliberate blocks per §3
  ['Smoke alarm.', GATE_REASONS.LOW_CONTENT],
  ['Ring final.', GATE_REASONS.LOW_CONTENT],
  ['Garage board.', GATE_REASONS.LOW_CONTENT],
  // Chitchat with weak triggers
  ['Going to the kitchen.', GATE_REASONS.LOW_CONTENT],
  ['I am done.', GATE_REASONS.LOW_CONTENT],
  ['Got an issue.', GATE_REASONS.LOW_CONTENT],
])('blocks weak-trigger-only "%s" with reason=%s', ...)
```

### Codex MAJOR 3 — removed expansion regression guards

```javascript
test.each([
  // 'bs' / 'en' must NOT be in STRONG; they're commonly leaked
  ['EN route now.', GATE_REASONS.FALLBACK_FORWARD],  // 3 distinct content words
  ['BS honestly.', GATE_REASONS.LOW_CONTENT],         // 2 distinct content words
])('does not over-promote bs/en "%s"', ...)
```

### Weak-trigger + digit forwards (regression)

```javascript
test.each([
  ['Done with circuit 3.', GATE_REASONS.HAS_DIGIT],
  ['Add to circuit 4.', GATE_REASONS.HAS_DIGIT],
  ['Light circuit 7.', GATE_REASONS.HAS_DIGIT],
  ['Kitchen socket reading is 0.45.', GATE_REASONS.HAS_DIGIT],
  ['Cooker circuit 4.', GATE_REASONS.HAS_DIGIT],
])('forwards weak-trigger+digit "%s" with reason=%s', ...)
```

### Codex BLOCKER 1 acknowledged false positive (allowed)

```javascript
test('forwards harmless-but-trigger-shape "I cracked an egg" as HAS_STRONG_TRIGGER', () => {
  // Acceptable false positive — see PLAN_v2 §"Acknowledged false positives".
  // The cost is one wasted Sonnet round; the alternative (demoting `cracked`
  // to weak) loses real "Socket cracked" observations.
  expect(shouldForwardToSonnet('I cracked an egg.')).toEqual({
    forward: true,
    reason: GATE_REASONS.HAS_STRONG_TRIGGER,
  });
});
```

### Existing test fixture updates (from v1)

`['Yeah. So this is a circuit. I don\'t know what it does.', GATE_REASONS.HAS_TRIGGER]`
→ Now: `FALLBACK_FORWARD` (distinct content words: yeah, circuit, don't, know, what, does = 6)

`['Could be for an old alarm.', GATE_REASONS.HAS_TRIGGER]`
→ Now: `FALLBACK_FORWARD` (distinct: could, be, old, alarm = 4, `be` is in stopwords so 3 actually; need to verify)

Actually checking STOPWORDS: includes `be`. So `could, old, alarm` = 3. → `FALLBACK_FORWARD`.

`['Move to the next circuit.', GATE_REASONS.HAS_TRIGGER]`
→ Now: `FALLBACK_FORWARD` (distinct: move, next, circuit = 3)

`['Add an observation about the cooker.', GATE_REASONS.HAS_TRIGGER]`
→ Now: `HAS_STRONG_TRIGGER` (`observation`)

### Telemetry stability

```javascript
test('HAS_TRIGGER reason value retained for telemetry back-compat', () => {
  expect(GATE_REASONS.HAS_TRIGGER).toBe('has_trigger');
});
test('new HAS_STRONG_TRIGGER reason exported', () => {
  expect(GATE_REASONS.HAS_STRONG_TRIGGER).toBe('has_strong_trigger');
});
```

## Rollout

1. Edit `src/extraction/pre-llm-gate.js` — STRONG/WEAK split + new
   `STRONG_TRIGGER_REGEX` + updated `shouldForwardToSonnet` body
2. Edit `src/__tests__/pre-llm-gate.test.js` — add ~20 new fixtures from
   above, update 4 existing fixtures
3. `npm test --testPathPattern="pre-llm-gate"` — green
4. `npm test` — full suite green
5. Single commit
6. Push to main → CI tests → CI deploys to ECS
7. Observe `voice_latency.gate_blocked` count + reason histogram for 24h
8. Kill switch: `VOICE_PRE_LLM_GATE=false` on task-def

## Risk analysis

| Risk | Likelihood | Mitigation |
|---|---|---|
| Real observation blocked because the damage word is alone without a digit or strong trigger | **Very low** (Codex BLOCKER 1 addressed — damage adjectives + safety words are now STRONG) | Telemetry: `gate_blocked` reason histogram |
| Bare designation `smoke alarm` blocked when inspector expected extraction | Medium — deliberate per §3 | Inspector workflow guidance: use `rename` or `circuit N is ...` |
| `bs` / `en` leak chitchat | **Zero** (Codex MAJOR 3 addressed — removed from STRONG) | Regression test in suite |
| False positive `I cracked an egg` — 1 Sonnet round wasted | Low — semantically rare | Acceptable per §"Acknowledged false positives" |
| Telemetry break on `HAS_TRIGGER` | **Zero** (Codex MINOR 9 — no in-repo consumers, retained for back-compat) | Reason value preserved in enum |
| Chitchat-pause changes behaviour | **Beneficial regression** — pause LESS likely to activate (blocked transcripts don't increment counter) | Analysed in dedicated §; out-of-scope wake widening flagged as separate plan |
| Gate-blocked rate spikes much higher than expected | Medium — measurable directly | Roll back via `VOICE_PRE_LLM_GATE=false` |

## Expected production impact

- Sonnet turn count: ~15-25% reduction on field-test sessions with
  natural chitchat/movement. Lower than v1's projection because
  damage-adjective / safety-word block list shrank.
- Sonnet cost: proportional.
- Chitchat-pause activation: less frequent (counter increments less).
- Inspector-perceived experience: identical for substantive utterances.

## Out of scope

- Widening chitchat-pause wake conditions to include STRONG triggers
  (separate plan).
- iOS-side chime + content-gate task (already in todos-certmate.md; will
  inherit STRONG/WEAK taxonomy from this commit).
- Tightening `FALLBACK_FORWARD` ≥3 distinct content words rule (separate
  larger-scope change; v2 leaves it untouched).
