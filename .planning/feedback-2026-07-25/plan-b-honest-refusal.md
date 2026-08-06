# Plan B — honest refusal: "I can't do that" ≠ "I didn't catch that"

**Feedback id:** 101 (secondary) · session `C06B9904`
**Repos:** backend `src/` only
**Depends on:** plan A (land A first)
**Verification lane:** unit + recorded fixture

---

## 1. Problem

When the model attempts something the system genuinely cannot do, the marker-② catch-all net speaks an apology from `CATCHALL_AUDIBILITY_PROMPTS` — wording that asks the inspector to **repeat himself**. Derek hit this three times in a row on "Delete Ze":

> *"if it can't do something why is it asking me to say the same thing again"*

Repeating a request the system structurally cannot satisfy produces an infinite loop, wastes the inspector's time, and erodes trust in every other read-back.

## 2. Evidence

- `src/extraction/stage6-shadow-harness.js:452` — `export const CATCHALL_AUDIBILITY_PROMPTS = Object.freeze([…])`.
- `src/extraction/stage6-shadow-harness.js:2671` — the net selects `CATCHALL_AUDIBILITY_PROMPTS[turnNum % CATCHALL_AUDIBILITY_PROMPTS.length]`, i.e. a rotating apology, **regardless of why** the turn produced nothing audible.

The net was built (marker-②, 2026-07-18) to enforce *"chime is a promise"* — a chimed turn always speaks. That invariant is correct and must not be weakened. The gap is that it has exactly **one** vocabulary: "I didn't catch that." It cannot distinguish:

| Cause | Correct response |
|---|---|
| Garble / genuinely unheard | "Sorry, say that again" — repeat is useful |
| Model no-op on a heard utterance | apology + retry — repeat may help |
| **Structural impossibility** (no tool exists for the request) | **"I can't do that yet"** — repeat is useless and actively harmful |

Today all three collapse into the first.

**Relationship to plan A:** A removes the specific instance Derek hit (board/supply clear). B fixes the *class* — the next unsupported request will hit the same wall. A also supplies the cleanest trigger evidence, which is why it lands first.

## 3. Fix

Add a **refusal branch** to the marker-② net that fires ahead of the generic apology when the turn's failure is attributable to a structural capability gap.

1. **Detect the refusal class deterministically — never by string-matching the model's prose.** Candidate signals, in preference order:
   - the model emitted a tool call the registry rejected as **unknown** (schema-validation failure with an unknown-tool discriminator);
   - a dispatched tool returned a structured error whose code marks the request out-of-capability (as opposed to a recoverable validation error such as `missing_value` or `board_not_found`);
   - the model called `ask_user` with a reason indicating it could not proceed **and** no tool in the registry covers the requested operation.

   `/rp` should adjudicate which of these are actually observable at the net's evaluation point — the net runs after the tool loop, so the loop ledger (attempted vs accumulated calls, per-round errors) is the natural evidence source. **If none of these signals is reliably available, this plan should be narrowed to "one refusal string, triggered by unknown-tool only" rather than guessed at.**
2. **A distinct wording family**, string-distinct from every existing apology family (the clients apply a 30 s text-keyed dedupe, so collisions silently swallow):
   > *"I can't do that yet — that isn't something I can change by voice."*

   Rotate as the existing family does, and include the requested operation when it is known and safe to name (leak-filter applies — never echo raw model text).
3. **Repeat suppression.** The same refusal for the same operation within a turn window speaks **once**; subsequent identical attempts stay silent or escalate to a terminal variant. This is the direct fix for Derek's three-in-a-row.
4. **Mutual exclusion.** The refusal branch is a *specific-first* branch of marker-② itself — it fires only when zero other speech-intent owns the turn, exactly like the F/U-2/F/U-3 voice notices. Never double-speak.
5. **Fail-closed.** If the refusal class cannot be established, fall through to the existing generic apology. Silence is never an outcome.

## 4. Files

| File | Change |
|---|---|
| `src/extraction/stage6-shadow-harness.js:452` | new `REFUSAL_PROMPTS` family alongside `CATCHALL_AUDIBILITY_PROMPTS` |
| `src/extraction/stage6-shadow-harness.js:~2671` | specific-first refusal branch + per-operation repeat suppression |
| tool-loop ledger / dispatcher error envelopes | expose the discriminator the branch keys on (design output of step 1) |

## 5. Tests

- **Unit** — unknown-tool call ⇒ refusal wording, not the generic apology.
- **Unit** — recoverable validation error (`missing_value`, `board_not_found`) ⇒ **generic** path unchanged (a refusal here would be wrong: repeating *does* help).
- **Unit** — garble/no-op turns ⇒ marker-① / marker-② behaviour byte-unchanged.
- **Unit** — three consecutive identical unsupported requests ⇒ one refusal (plus at most a terminal variant), never three identical strings.
- **Unit** — mutual exclusion: a turn with any other audible output never emits a refusal.
- **Unit** — string-distinctness across all apology/refusal/notice families (extend the existing family-distinctness assertion).
- **Recorded fixture** — a pre-plan-A "Delete Ze" transcript replayed against the refusal branch ⇒ one refusal, zero generic apologies. Note this fixture documents the *class*; after A lands, that specific utterance succeeds instead.

## 6. Web companion

**None required.** The refusal rides the existing field-nil confirmation channel both clients already render (same channel as the F7/marker-① apologies). Dated parity-ledger note, owner **Derek**.

## 7. Risks

- **Weakening "chime is a promise".** The net must remain fail-closed: an unclassifiable turn still speaks. Pin this explicitly.
- **False refusals.** Telling an inspector "I can't do that" when the system *can* is worse than the generic apology — it trains him not to try. Keep the trigger set narrow and evidence-based; when in doubt, generic.
- **Speculative detection.** The step-1 signal set is the weakest part of this plan and is the thing `/rp` should attack hardest. Narrowing to unknown-tool-only is an acceptable and preferable outcome if the richer signals are not cleanly observable.

## 8. Acceptance criteria

1. A structurally impossible request draws a refusal, not a "say it again" apology.
2. A recoverable failure still draws the existing apology.
3. Repeated identical impossible requests do not produce repeated identical apologies.
4. No chimed turn is ever silent (marker-② invariant intact).
5. Full backend suite + field-replay corpus green.
