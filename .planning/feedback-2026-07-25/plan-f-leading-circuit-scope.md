# Plan F — dialogue-script entry must accept a circuit stated *before* the trigger

**Feedback id:** 98 · session `2D8E432D` (pre-`:344`)
**Repos:** backend `src/` only
**Verification lane:** unit + dialogue-engine replay parity + recorded fixture

---

## 1. Problem

Derek said:

> *"Circuit 10, ring continuity lives are 0.61…"*

The ring-continuity script entered, ignored the circuit he had just stated, and asked:

> *"Which circuit is the ring continuity for?"*

He had already answered the question in the utterance that triggered the script. For a hands-free inspector this is the most irritating possible failure: the system demonstrably heard the sentence (it entered the script) but discarded half of it.

## 2. Evidence

The entry patterns capture `circuit N` **only when it follows the trigger token**.

`src/extraction/dialogue-engine/schemas/ring-continuity.js` (the **live** path):

```js
// Pattern 1
/\b(?:(?:ring|bring|wing)\s+(?:continu(?:ity|ance|ancy|ed|e)|final)|re-?continuity)\b(?:[^.?!]{0,50}?\bcircuit\s*(\d{1,3})\b)?/i,   // :96
// Pattern 2
/^(?:\s*(?:so|right|ok(?:ay)?|now)[\s,]+)?\b(?:ring|bring|wing)\b[^.?!]{0,30}?\bcircuit\s*(\d{1,3})\b/i,                            // :98
```

- Pattern 1's circuit group sits in a **trailing** optional group — `"Circuit 10, ring continuity…"` matches the trigger but leaves group 1 `undefined`.
- Pattern 2 is `^`-anchored to optional filler + the ring token, so a leading `"Circuit 10,"` fails the anchor outright.

`src/extraction/ring-continuity-script.js` (the legacy twin, kept byte-parallel by an explicit sync contract):

- `:120–139` — the same two patterns.
- `:346–357` — `detectEntry` returns `circuit_ref: m[1] ? Number(m[1]) : null`.
- `:948` — `let circuitRef = entry.circuit_ref;` → `null`.
- `:1012–1029` — `circuitRef === null` ⇒ `buildScriptAsk({ kind: 'which_circuit' })`.
- `:608–618` — the ask: `question: 'Which circuit is the ring continuity for?'`, `tool_call_id: srv-rcs-${sessionId}-which-${now}`.

**Same defect in the insulation-resistance schema** — `src/extraction/dialogue-engine/schemas/insulation-resistance.js:184` has the identical trailing-only capture, and `:221` the twin question *"Which circuit is the insulation resistance for?"*. Its legacy twin ask is at `src/extraction/insulation-resistance-script.js:457`.

**Not a total loss today:** the volunteered readings *are* preserved — `ring-continuity-script.js:970–995` queues them in `pending_writes` until the circuit resolves (the "Bug A" fix from session 74201B27). So this is purely a needless question, not data loss. That keeps the blast radius small.

## 3. Root cause

The entry regexes model only one word order — *"ring continuity for circuit N"* — while natural dictation frequently leads with the scope: *"Circuit 10, ring continuity…"*.

## 4. Fix

Extend circuit capture to a **leading** position, in both schemas and both legacy twins, keeping the four patterns in lock-step.

1. Add a leading-circuit alternative to Pattern 1 in each schema, e.g. a bounded prefix group `\bcircuit\s*(\d{1,3})\b[^.?!]{0,20}?` before the trigger. Constraints:
   - **bounded** proximity (mirror the existing 50/30-char discipline) so `"circuit 10 is fine … later, ring continuity"` cannot bind across a clause;
   - clause-bounded via the existing `[^.?!]` class;
   - the capture must land in a **stable group index** — the twin, the schema, and `detectEntry` all index `m[1]`. Prefer two named/ordered groups with an explicit "first defined wins" resolution over renumbering, and assert the resolution in a test.
2. Preserve every existing exclusion:
   - `RING_ENTRY_EXCLUSION_PATTERN` (`ring-continuity-script.js:149`) — destructive verbs still bypass the script so delete requests reach the model (the P1 contract).
   - the `\bcircuit\s+\d+\s+is\b` exclusion (schema `:131`, IR schema `:195`) — `"circuit 4 is the cooker"` must not enter a script.
   - `"the phone is ringing"` / `"the ring main"` false positives must stay excluded.
3. Apply the same change to the IR schema + twin.
4. Do **not** widen to fuzzy matching — the enumerated-garbles-only rule (parity §3E) stands.

## 5. Files

| File | Change |
|---|---|
| `src/extraction/dialogue-engine/schemas/ring-continuity.js:96,98` | leading-circuit capture |
| `src/extraction/dialogue-engine/schemas/insulation-resistance.js:184` | leading-circuit capture |
| `src/extraction/ring-continuity-script.js:120–139, 346–357` | mirror (byte-parity contract) |
| `src/extraction/insulation-resistance-script.js` (entry patterns) | mirror |

## 6. Tests

- **Unit, both scripts** — `"Circuit 10, ring continuity lives are 0.61"` ⇒ `{ matched: true, circuit_ref: 10 }`; no `which_circuit` ask; the volunteered `0.61` writes immediately rather than queueing.
- **Unit** — trailing form `"ring continuity for circuit 13"` still yields `13` (no regression).
- **Unit** — both-positions form (`"Circuit 10, ring continuity for circuit 13"`) resolves deterministically; assert which one wins and why.
- **Unit** — every existing exclusion still excludes: destructive verbs, `\bcircuit\s+\d+\s+is\b`, `"the phone is ringing"`, `"the ring main"`.
- **Replay parity** — `dialogue-engine-replay.test.js` must stay green; the twin and the schema must remain byte-parallel (this is an enforced contract, not a convention).
- **Recorded fixture** — from `2D8E432D`: entry with a leading circuit produces zero `srv-rcs-…-which-…` asks and one value ask (or a confirmation, if all three legs were volunteered).

## 7. Web companion

**None required.** Backend-only; the dialogue engine is server-side for both clients and no wire shape changes. Dated parity-ledger note only, owner **Derek**.

## 8. Risks

- **Group-index drift** between schema and twin is the single most likely way to break this — the twin's `detectEntry` hard-codes `m[1]`. Pin group resolution with a test in *both* files.
- **Over-matching.** A leading circuit ref is a common sentence opener; a too-loose proximity bound could capture an unrelated circuit mentioned earlier in the clause. Keep the bound tight (≤ ~20 chars) and test the negative cases explicitly.
- **IR script scope.** Including IR doubles the surface. It is the same one-line change in the same shape, and leaving it would guarantee a repeat report — keep it in, but treat the IR tests as mandatory, not optional.

## 9. Acceptance criteria

1. `"Circuit N, ring continuity …"` and `"Circuit N, insulation resistance …"` enter their scripts scoped to circuit N.
2. No `which_circuit` ask fires when the circuit was stated anywhere in the entry utterance.
3. All existing entry/exclusion behaviour is byte-unchanged.
4. Schema↔twin parity holds; replay suite green.
5. Full backend suite + field-replay corpus green.
