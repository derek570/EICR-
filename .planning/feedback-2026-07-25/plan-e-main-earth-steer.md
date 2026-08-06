# Plan E — prompt steer: "main earth" is a conductor size, not an impedance

**Feedback id:** 100(a) · session `C06B9904` (post-`:344`, iOS build 421)
**Repos:** backend `config/prompts/` only — **prompt-only, zero wire change**
**Verification lane:** LIVE probes post-deploy (model-decision bug — **not** fixture-lockable)

---

## 1. Problem

Derek dictated a **main earth** value. The model wrote it to `earth_loop_impedance_ze` (an impedance, in ohms) instead of `earthing_conductor_csa` (a conductor cross-sectional area, in mm²).

Two different quantities, two different units, two different certificate boxes. The value landed in the wrong field and — compounded by the silent impedance clamp (plan D) — was then divided by 10 to make it "plausible" as a Ze.

## 2. Evidence

- The session wrote `earth_loop_impedance_ze` on a turn whose transcript names the **main earth**.
- Both fields are in `BOARD_FIELD_ENUM` (`supply_characteristics ∪ board_fields ∪ installation_details`), so both were available to the model — this is a **selection** error, not a missing-capability error.
- The two field names are semantically adjacent to a language model: *earth* appears in both, and "main earth" carries no unit word in normal dictation.

## 3. Root cause

Ambiguous natural-language mapping with no disambiguating steer in the system prompt. The inspector's vocabulary ("main earth", "main earthing conductor", "the earth is 16") does not lexically resemble either canonical field name.

## 4. Fix

One targeted steer in `config/prompts/sonnet_agentic_system.md`, in the shared region (both flag renders).

Content:

1. **Vocabulary mapping** — "main earth" / "main earthing conductor" / "earthing conductor" ⇒ `earthing_conductor_csa` (mm²). Never `earth_loop_impedance_ze`.
2. **The deciding fact is the unit/magnitude, and it should be weighted, not ignored:**
   - `earthing_conductor_csa` — a conductor size in **mm²**, realistically from a small enumerated set (6, 10, 16, 25, 35 …).
   - `earth_loop_impedance_ze` — an **impedance in ohms**, typically well under 1 Ω for TN-C-S, under ~21 Ω for TT.
   - A bare "16" alongside "main earth" is overwhelmingly a 16 mm² conductor, not a 16 Ω Ze (which would be a failed TN installation).
3. **`Ze` stays `Ze`** — an explicit "Ze"/"Z e" anchor still maps to `earth_loop_impedance_ze`. The steer must not cannibalise the correct path (note P6 already normalises the spaced `"Z s"`/`"Z e"` garble class upstream).
4. **Ask on genuine ambiguity** — if the utterance names an earth quantity with a value that is implausible for both readings, ask which, naming the deciding fact (unit), per the established D2 clarification style. Never blanket-default.

Keep the edit **terse**. The prompt suites assert measured token caps; expect a small increase and bump caps to `measured + ~100` **with the measurement shown**, per the P8 precedent.

## 5. Files

| File | Change |
|---|---|
| `config/prompts/sonnet_agentic_system.md` | one steer block in the shared region |
| `src/__tests__/stage6-agentic-prompt.test.js` | pinned-content assertions + measured cap bump |

## 6. Verification lane — LIVE only

This is a **model-decision bug**. A recorded fixture freezes the model's response, so it can only lock *backend handling*, never the model's field choice. Recorded fixtures therefore **cannot** verify this fix.

Verification is:

1. **Prompt-content pins** — assert the steer renders in both flag states (the steer lands in the shared region outside the A1 marker blocks, so both renders grow).
2. **Post-deploy live probes**, run after the ECS rollout, ear-verified:
   - *"Main earth is 16"* ⇒ `earthing_conductor_csa = 16`, read back with the conductor phrasing.
   - *"Main earthing conductor 10 mil"* ⇒ `earthing_conductor_csa = 10`.
   - *"Ze is 0.35"* ⇒ `earth_loop_impedance_ze = 0.35` (regression — the steer must not steal this).
   - *"The earth is 16"* with no further context ⇒ acceptable outcomes are the conductor write **or** a targeted ask naming the unit; **not** a silent Ze write.
3. The advisory nightly live lane picks up residual drift.

**The probes are REQUIRED**, not optional, and must be recorded in the execution log with their outcomes — a merged prompt steer with unrun probes is an unverified change.

## 7. Web companion

**None required.** Prompt-only; no wire change; both clients ride the same backend. Dated parity-ledger note, owner **Derek**.

## 8. Risks

- **Cannibalising the Ze path.** The single largest risk: over-steering makes the model write conductor CSA when the inspector genuinely said Ze. Probe 3 exists specifically to catch this and is a blocking probe.
- **Prompt-cache invalidation.** One edit; if plan A also lands a prompt change, batch both into a single edit to pay the invalidation once (the P8 precedent).
- **Token budget.** Binding gate. Measure before and after; do not hand-wave the cap bump.
- **Interaction with plan D.** D's clamp is what turned the wrong-field write into a *silently altered* value. E prevents the wrong field; D prevents the silent alteration. Neither substitutes for the other.

## 9. Acceptance criteria

1. "Main earth" and its variants map to `earthing_conductor_csa`.
2. Explicit "Ze" still maps to `earth_loop_impedance_ze` (no regression).
3. Genuinely ambiguous cases ask, naming the deciding fact.
4. Both flag renders carry the steer; token caps re-measured and pinned.
5. All four live probes run, ear-verified, and recorded in the execution log.
