# Plan A — add `clear_board_reading` (board/supply-scope clear)

**Feedback id:** 101 · session `C06B9904` (post-`:344`, iOS build 421)
**Repos:** backend `src/` only
**Verification lane:** unit + recorded fixture (backend-deterministic)

---

## 1. Problem

Derek said **"Delete Ze"** (a board/supply-scope field). The assistant apologised and asked him to say it again — **three times**. His feedback:

> *"if it can't do something why is it asking me to say the same thing again"*

The model has no tool that can clear a board- or supply-scope reading, so every attempt ends in a marker-② catch-all apology whose wording ("say that again") invites an infinite retry loop on a request the system can never fulfil.

## 2. Evidence

`src/extraction/stage6-tool-schemas.js`:

- `clear_reading` requires `['field', 'circuit', 'reason']` with `circuit` an **integer**. Its enum, `CLEAR_READING_FIELD_ENUM`, is `Object.keys(fieldSchema.circuit_fields)` minus `circuit_ref` / `is_distribution_circuit` / `feeds_board_id`. **Circuit-scope only.**
- `record_board_reading` (≈`:710–743`) has `enum: BOARD_FIELD_ENUM` = `supply_characteristics ∪ board_fields ∪ installation_details`. **Writing** board/supply fields is fully supported.
- There is **no `clear_board_reading`** anywhere in the 18-tool registry.

So the asymmetry is exact: the model can *write* `earth_loop_impedance_ze` but cannot *clear* it.

**Perfect contrast, same session:** a circuit-scope clear worked flawlessly — the assistant spoke *"Cooker, R1 plus R2 cleared."* This proves the defect is **scope-specific**, not a general clear-path failure.

### Direct precedent

`stage6-tool-schemas.js` ≈`:782–794`, the `delete_circuit` comment:

> *"Added 2026-05-04 after field test 07635782 showed the inspector saying 'delete circuit 2' twice with no effect (the tool didn't exist; Sonnet's only path was to apologise via ask_user)."*

Identical failure shape, identical remedy. This plan is that precedent applied to board/supply scope.

### Causal link to plan D

The `ze` Derek was trying to delete was the bogus `1.6` produced by the silent impedance divide (feedback id 100(b), plan D). D removes the cause; A makes the recovery possible. Both are needed.

## 3. Fix

Add a `clear_board_reading` tool mirroring `clear_reading`, scoped to board/supply fields.

1. **Schema** (`src/extraction/stage6-tool-schemas.js`):
   - New `CLEAR_BOARD_READING_FIELD_ENUM`, derived the same way `BOARD_FIELD_ENUM` is (`supply_characteristics ∪ board_fields ∪ installation_details`), minus any identity/structural keys that must never be cleared — mirror the `clear_reading` exclusion discipline (`circuit_ref` / `is_distribution_circuit` / `feeds_board_id` are its analogues; determine the board-scope equivalents from `config/field_schema.json` rather than guessing).
   - Required params: `field`, `reason`. `board_id` **optional** — resolve to the effective board the same way `record_board_reading` does, so a single-board job needs no board named and a multi-board job can target one. Do **not** accept `board_id: '*'` (broadcast clear is not a thing the inspector asks for and is destructive).
2. **Dispatcher** — a `dispatchClearBoardReading` mirroring `dispatchClearReading`, including:
   - the same-turn write/clear collapse semantics established by **P5** (a clear must not wipe a surviving same-turn write for the same slot, and vice versa) — note P5 explicitly scoped itself to *circuit* slots and excluded `boardReadings`; extending the collapse to board slots is **in scope for this plan** and must be designed, not assumed;
   - emission of the same `field_corrected` / `cleared_readings` wire shapes the circuit path already uses, so **no client decoder change is required**;
   - a spoken confirmation matching the circuit-path phrasing (*"Ze cleared."*), satisfying Audio-First #1.
3. **Prompt** (`config/prompts/sonnet_agentic_system.md`) — register the tool and state when to use it (board/supply-scope clear) versus `clear_reading` (circuit scope). Keep the edit minimal; it invalidates the prompt cache.
4. **Validation** — unknown field → structured error; unknown `board_id` → `board_not_found`; already-empty field → a benign no-op that still speaks (*"Ze is already blank."*) rather than an apology.

## 4. Files

| File | Change |
|---|---|
| `src/extraction/stage6-tool-schemas.js` | new tool schema + enum |
| `src/extraction/` dispatcher (alongside `dispatchClearReading`) | new `dispatchClearBoardReading` |
| `src/extraction/stage6-event-bundler.js` | confirmation synthesis for the board clear (+ same-turn collapse for board slots) |
| `config/prompts/sonnet_agentic_system.md` | tool registration + scope guidance |
| `config/field_schema.json` | read-only — source of the enum |

## 5. Tests

- **Unit** — enum derivation matches `BOARD_FIELD_ENUM` minus the excluded identity keys; the exclusion list is asserted explicitly so a schema addition cannot silently become clearable.
- **Unit** — clear on a single-board job with no `board_id`; clear on a multi-board job with an explicit `board_id`; `board_not_found`; `board_id: '*'` rejected.
- **Unit** — clear of an already-empty field speaks and does not apologise.
- **Unit** — same-turn write→clear and clear→write for a board slot collapse correctly (extends the P5 matrix to board scope).
- **Recorded fixture** — from session `C06B9904`: "Delete Ze" now produces a `clear_board_reading` call, a cleared field, and exactly one spoken confirmation; **zero** marker-② apologies. This is backend-deterministic *given* a model response that calls the new tool — author the fixture accordingly, and note that whether the model *chooses* the tool is a live-lane question (see plan E's lane note).
- **Prompt-token budget** — the prompt suites assert measured caps. Expect a small increase; bump the caps to `measured + ~100` only with the measurement shown, per the P8 precedent.

## 6. Web companion

**None required.** The clear rides the existing `field_corrected` / `cleared_readings` frames both clients already decode. Record a dated parity-ledger note confirming no web code change was needed, owner **Derek**.

## 7. Risks

- **Destructive tool.** A clear that hits the wrong board destroys a measured value. Mitigations: no `'*'` broadcast; explicit `board_not_found` rather than a silent fallback to the main board; the spoken confirmation names the field so a wrong clear is immediately audible.
- **Prompt-cache invalidation.** One edit; batch it with plan E's steer if both are executed in the same wave to pay the invalidation once.
- **Scope creep into P5.** Extending same-turn collapse to board slots touches P5's machinery. Keep the change additive (a parallel board-slot identity) rather than rewriting the circuit path.

## 8. Acceptance criteria

1. "Delete Ze" clears the field and speaks exactly one confirmation.
2. No marker-② apology fires on a board/supply clear request.
3. Circuit-scope `clear_reading` behaviour is byte-unchanged.
4. No wire-shape change; no client decoder change.
5. Full backend suite + field-replay corpus green.
