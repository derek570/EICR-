# /ep execution log — A2-core (`replaces_cleared`)

- **Plan:** `~/.claude/handoffs/EICR_Automation--replaces-cleared-chain-a2-2026-07-26/PLAN-final.md`
- **Wave:** `feedback-2026-07-25-batch-resume-20260727`, **hop 5** of the chain
- **Session:** `20260728T112819Z-ep`
- **Repo:** `/Users/derekbeckley/Developer/EICR_Automation` (worktree `…-ep-20260728T112819Z-ep`, branch `ep/PLAN-20260728T112819Z-ep`, base `origin/main` @ `e60f04f3`)
- **PRs:** backend+web [EICR- #127](https://github.com/derek570/EICR-/pull/127) · iOS test-pin [CertMateUnified #40](https://github.com/derek570/CertMateUnified/pull/40)
- **Verdict:** ALL PASSED · Codex **PASSED** (9 cycles) → READY PR → merge → deploy

---

## What shipped

P5 (2026-07-23) collapses a same-turn `clear_reading` + `record_reading` for one circuit slot **server-side**, so web receives a bare write against a still-populated cell. Web's `applyCircuitReadings` 3-tier gate is fill-only and source-agnostic —

```ts
if (hasValue(row[column]) && !isLimWrite) continue;
```

— so it **silently skipped**. The assistant spoke the replacement, the backend and iOS stored it, web kept the stale value: the inverse Audio-First violation (spoken-but-not-written) in a legally-significant certificate. P5's changelog claim that dropping the frames left "both clients coherent" was wrong for web and is corrected in this PR.

**Fix:** the bundler stamps an omit-when-false boolean `replaces_cleared: true` on the surviving reading of a collapsed turn; web decodes it and, gated on board evidence, bypasses the fill-only gate for exactly that write.

### Wire-shape honesty

`replaces_cleared` is **ADDITIVE-OPTIONAL, not "zero wire-shape change"** — an un-collapsed turn is byte-identical to pre-A2 traffic, but a collapsed turn carries one new enumerable key. What stands in for a capability gate is *verified* unknown-key tolerance on every consumer, checked rather than assumed:

- **iOS** — `ExtractedReading` declares explicit `CodingKeys`, so the key decodes inertly. The iOS half is genuinely test-only.
- **web** — permissive `JSON.parse`.
- **replay oracles** — project readings to circuit/field/value.

### Producer (backend)

- `EFFECTIVE_CIRCUIT_SLOT`-keyed candidate index, **split the same way the P5 collapse matches** (effective-stamped bucket vs Symbol-less raw-key bucket). `EFFECTIVE_BOARD_SLOT` (plan A1a) is a distinct Symbol and is never cross-wired.
- **Fail-closed-unflagged:** >1 candidate for a slot ⇒ stamp nothing, push the slot key onto a non-enumerable `REPLACES_CLEARED_AMBIGUOUS_PROJECTION` Symbol. The bundler stays **PURE** (no logging); the harness emits `stage6.replaces_cleared_ambiguous_projection` on **both** lanes.
- `derived: true` writes excluded. **Calculator writes (`::calc::`) remain candidates** — per F/U-1 (2026-07-19) a calc result is explicitly-requested and spoken.
- `projectExtractionResultForWire` promoted to a named egress seam (hoisted destructure-spread, deliberately **never** an allowlist) shared by `buildResultFrameLedger` and `session.onBatchResult`.

### Consumer (web) — the board-evidence guard

Web's apply is ref-only, so the bypass is gated on web proving *independently* that the write targets the right row. The governing principle: **a board id the SERVER asserts this turn can never vouch for itself.** Only web's own `boards[]` registry and the scopes of its existing rows are independent evidence.

Five doors, all the same wrong-board class:

| term | declines when |
|---|---|
| `ids` cardinality | union of `job.boards` ids + row `board_id`s + envelope reading `board_id`s + every id named by `board_ops` resolves to >1 |
| `addsBoardThisTurn` | a same-envelope `add_board` — `onBoardOps` fires **after** `onExtraction`, so `job.boards` is stale at apply time |
| `unknownNamedBoard` | the server names a board web has no record of |
| `implicitUnregisteredBoard` | a CHILD board owns no row beside unscoped rows |
| `mixedRowScopes` | the ROWS carry more than one scope |

`BACKEND_DEFAULT_MAIN_BOARD_ID` (`'main'`) is seeded into the independence set **only** when web has zero independent evidence (legacy flat job) — into `independent`, **not** `ids`, so cardinality is unaffected. Ordering vs `implicitUnregisteredBoard` is load-bearing.

**Never a new skip.** Every decline falls through to the unchanged gate, so an empty cell still fills. Success logs `apply_replaces_cleared_bypass_applied`; declines log `_multiboard_deferred` / `_orphan_ref` / `_duplicate_ref`.

---

## Codex review loop — 9 cycles

The plan converged through `/rp` with zero BLOCKERs, and the gate was green from cycle 1. **Every one of cycles 1–8 still found a real, test-invisible wrong-board write.** That is the calibration point for this plan class: a green suite proved nothing about the guard, because the guard's whole job is to be correct on job shapes no test author had thought to construct.

| cycle | finding | fix | commit |
|---|---|---|---|
| 1 | same-envelope `add_board` — `board_ops` rides the same envelope but `onBoardOps` fires *after* `onExtraction`, so `job.boards` is stale at apply time | `addsBoardThisTurn` | `fb9f398c` |
| 2 | an unevidenced `select_board` defers too; the wire fixture was hand-built, not from the real frame builder | broadened + fixture regenerated from the producer | `0ec273ec` |
| 3 | a board id the server names this turn was being counted as its own evidence | `independent` snapshot taken *before* any server-named id | `ed8d438a` |
| 4 | the backend's synthesised default main board (`DEFAULT_MAIN_BOARD_ID = 'main'`) read as an *unknown* board on a legacy flat job, so the bypass never fired there | `BACKEND_DEFAULT_MAIN_BOARD_ID` seed, gated on `independent.size === 0` | `f2df6845` |
| 5 | a registry board that no row is scoped to is a SECOND board, not the only one | `implicitUnregisteredBoard` | `557d5806` |
| 6 | …but a MAIN board owning no row *is* the single board — cycle 5 over-deferred | type-aware narrowing | `512138f9` |
| 7 | `off_peak` is a SIBLING of main (top-level per the closed `BoardType` union + the Board tab's parent-clearing), not a sub-board — it must not defer | closed-union handling; absent type reads as main | `b857bf37` |
| 8 | a child board owning SOME row (just not the target ref row) walked past the registry test entirely | `mixedRowScopes` | `3fa27c52` |
| 9 | — | **NO NEW FINDINGS** | — |

### Cycle 8 — the one I extended

Codex's scenario: unscoped legacy circuit 1 (an unregistered main) + circuit 2 scoped to child board `sub-1`, registry `[sub-1]`. Backend is on `sub-1` and emits a collapsed clear→write for circuit 1 that **omits `board_id`** (`dispatchRecordReading` stores only the raw `input.board_id`, and the bundler emits the key only when it exists — so whenever the model relies on the current board the field is simply absent, and the reading term is blind). `rowScopedIds` contains `sub-1`, so the registry term is quiet; cardinality is 1; `refMatches === 1`, so no duplicate-ref decline. **The bypass overwrites the unregistered main's circuit 1 with sub-1's reading.**

Verifying it in source turned up a **second instance Codex did not find**: `applyAddNewBoardMode` (`web/src/lib/recording/apply-ccu-analysis.ts`) deliberately leaves `board_type` **unset** on an appended sub-board — its docstring says board type belongs to the inspector via the Board tab, not the CCU photo — so a CCU-appended SUB board reads as **top-level** and `isSub` is false. The type-based term could never have fired on the *commonest producer of the two-scope shape*.

Both are one defect stated at the wrong layer: the guard reasoned about the **registry** when the decisive evidence is the **rows**. Fixed with `mixedRowScopes` (scope count = distinct row `board_id`s + 1 if any row is unscoped; >1 defers), **disjoined with** — not replacing — the registry term, so cycle 5's all-unscoped shape still defers.

### Cycle 9 — forcing a real verdict

Cycle 8's first submission came back as a bare `CLEAN` in 264 tokens. Per the dead-reviewer-lens rule that is **not** a converging round — a verdict is only evidence if the reviewer's *work* is evidenced. Re-submitted with a mandatory three-section output contract, which produced the real IMPORTANT finding above:

- **A — evidence:** ≥8 verbatim `file:line` quotes spanning the producer index, the fail-closed branch, the egress seam, the decode, every guard term, the bypass site, and the unchanged fall-through.
- **B — discrimination:** for each guard term, name the test that reddens if the term is deleted, and say whether any test passes for the *wrong* reason.
- **C — findings.**

Cycle 9 returned 33 verbatim quotes, a per-term discrimination table, and `NO NEW FINDINGS`. Its section B is worth keeping: it names, per term, which tests are genuinely discriminating and which pass only because a *different* term also fires (e.g. `source 4 — a same-envelope add_board defers` would still pass with `addsBoardThisTurn` deleted, because that op also trips cardinality and `unknownNamedBoard` — the discriminating test is `source 4b`, the **empty-id** op). Every term has at least one discriminating test.

### Post-review — the docs lagged the code (`6ab66408`)

Re-reading `web/docs/parity-ledger.md` before merge caught a self-inflicted problem the review loop had no reason to look at: the `recording/replaces-cleared-write` row's web column was written at cycle 1 and still described the bypass as gated on **board cardinality alone**. Cycles 5–8 had added four more terms and a seeded default without the row moving. The ledger is the contract a future reader trusts when deciding whether web still matches iOS, and an under-described guard invites the wrong repair — reading "cardinality ≤ 1", the extra terms look like redundant belt-and-braces worth deleting. Corrected in place (all five terms, the seed and its load-bearing ordering, the governing principle, and *why* term 5 is blind to which board is which); the "declining is never a new skip" clause is unchanged. Docs-only, and it re-ran the full gate on push.

---

## Deliberate decisions (not defects)

- **`mixedRowScopes` is blind to which board is which.** Web cannot distinguish `append_rail` (new rows scoped to the SAME board the unscoped legacy rows belong to — safe) from `add_new_board` (a DIFFERENT board — a wrong-board write): both produce **byte-identical** mixed row scoping. So it declines both, on the asymmetry — a stale value is the recoverable pre-A2 status quo and the inspector can re-dictate it; a wrong-board overwrite is *new* corruption of a cell the inspector never spoke about, in a legally-significant certificate, and no read-back can catch it by ear. The guard exists on that asymmetry.
- This **subsumes the ambiguous CCU `off_peak`-append residual** recorded as owned at cycle 7 — that shape now declines on its rows rather than bypassing on its type, so the tie never has to be broken.
- **Calculator writes remain candidates**; `derived: true` writes do not.
- **The bundler stays pure.** All ambiguous-projection telemetry is the harness's, on both lanes.

## Deviations from the written plan

None of substance. The plan's guard was a single-board cardinality check; cycles 1–8 grew it into five terms. That is elaboration within the plan's stated intent ("bypass only when web can prove the target row"), not a deviation from it — no plan step was skipped, and no ambiguity-ladder rule 3 skip was taken.

---

## Gates

| gate | result |
|---|---|
| Backend Jest | **6457 passed / 19 skipped / 0 failed** |
| Web vitest | **1510 passed / 1 skipped** (A2 consumer suite RED-proven 12/15 → **38/38**) |
| Field-replay corpus (recorded, strict) | **9/9** |
| `tsc --noEmit` | at the two known baseline files, zero new |
| iOS suite | **1530 / 0** |
| Codex diff review | **PASSED** at cycle 9 (cap 10) |

### One process lesson worth keeping

**Vitest does not typecheck.** The full 1510-test suite was green while `mixedRowScopes` was missing from the explicit `boardEvidence` type annotation — a real `TS2339`. Only `tsc --noEmit` caught it. Always run tsc after touching a typed return shape; the suite will not.

---

## Follow-ups

Logged to `~/obsidian-vault/active/todos-certmate.md`. None are decision-class, so nothing was added to `ep-digest.md`.

1. **Full `(board_id, circuit_ref)` routing for the web apply path.** The real fix for `append_rail`-on-a-legacy-job, which now deliberately declines the bypass. Owned by the A2-multiboard plan (hop 6 — `replaces-cleared-multiboard-2026-07-27`).
2. **Utterance-correlated freshness for `replaces_cleared`** — accepted mid-flight manual-edit race (an inspector editing the cell between utterance and apply).
3. **iOS fixture literal ↔ shared JSON fixture drift.** The iOS pin hard-codes the frame; needs a generated resource or a CI hash comparison against `tests/fixtures/test-contracts/replaces-cleared-circuit.json`.
4. **Web has several ad-hoc notions of board identity** — `isUnscopedBoardId` is duplicated in `apply-ccu-analysis.ts:65` and `circuits/page.tsx:296`, plus the bare `'main'` literal. Worth consolidating; the A2 guard now depends on getting this right.
5. **`applyBoardOpsToJob`'s `add_board` should materialise the implicit main board the way the backend does.** That would make web's registry self-consistent and retire the `implicitUnregisteredBoard` heuristic entirely.
6. **Pre-existing (not caused here):** the LIM/multi-board overwrite on the same ref-only routing.

## Chain

Hop 5 complete. Next eligible wave member (oldest unclaimed `feedback-2026-07-25-batch-resume-20260727` plan): `EICR_Automation--replaces-cleared-multiboard-2026-07-27` — the direct successor, which owns follow-up 1. Spawned as hop 6.
