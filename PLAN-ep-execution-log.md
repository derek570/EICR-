# /ep execution log — Plan D (read-back must reflect the stored value)

- **Plan:** `~/.claude/handoffs/EICR_Automation--readback-reflects-stored-value-2026-07-25/PLAN-final.md`
- **Feedback id:** 100(b) · session `C06B9904` · SAFETY-CRITICAL, highest in the 2026-07-25 wave
- **Session id:** `20260725T143458Z-ep`
- **Repo root:** `/Users/derekbeckley/Developer/EICR_Automation`
- **Worktree:** `/Users/derekbeckley/Developer/EICR_Automation-ep-20260725T143458Z-ep`
- **Branch:** `ep/PLAN-20260725T143458Z-ep` off `main` @ `dfeb959f`
- **Chain:** `--chain` passed; plan carries a sibling `.ep-queue` marker (wave member) → chain active.
- **Started:** 2026-07-25T14:39:43Z

---

## [PLAN-SIZE] warning

`[PLAN-SIZE]` this plan bundles ~15 top-level items across ONE high-interaction subsystem
(Stage-6 extraction: new clamp module · 3 dispatcher pre-write seams · 3 dialogue seams incl. 12
`applyWrite` invocations · confirmation-text phrasing + `buildFanoutGroupKey` identity · bundler
correction transport · speculator ×2 entry points · orphan recovery · earthing ingest/seeding ·
`session_ack` capability ×4 sites ×3 modes · fast-TTS route · new Jest suite · RED→GREEN fixture ·
web companion · iOS unit). Review effort scales with interaction count — expect a long Codex
convergence. Consider splitting future plans of this shape at `/rp` time.

Mitigating factor: `/rp` already converged it to zero BLOCKERs over six rounds, and the plan
enumerates every seam explicitly, so the surface is known rather than discovered during execution.

---

## Phase 0 (§7.1) — recorded-fixture provenance: **BRANCH 1 (capture is usable)**

**Decision: Branch 1.** A faithful frozen model round for `C06B9904` exists and the fixture is
authorable. Recorded below in full because §7.1 requires the branch to be stated either way.

### Where the evidence came from

The S3 analytics bundle is **not** the source — `s3://eicr-files-production/session-analytics/…/C06B9904…/`
contains only `cost_summary.json` (704 B): no `debug_log.jsonl`, no model rounds. (Note for future
runs: the bucket is `eicr-files-production`, **not** `eicr-certificates-production`, which does not
exist.)

CloudWatch `/ecs/eicr/eicr-backend` **does** still retain the session, and that is the sanctioned
source: the existing fixture `frc_b6ec5356f67d8655db214b4f16ae8d83`'s own provenance comment records
that its transcript + model behaviour + chime are `recorded_full` **from the CloudWatch capture**,
with `initial_state_fidelity: hand_authored`. This fixture follows that precedent exactly.

### The frozen round (turn 4, 2026-07-25 07:59:54 – 08:00:02 UTC)

| Evidence | Value |
|---|---|
| Transcript (Flux raw) | `Main earth is sixteen now.` |
| Transcript (normalised, as ingested) | `Main earth is 16 now.` |
| Tool call | `record_board_reading`, `tool_use_id: toolu_01G7KFg89h7hms6EyiG6RJfB`, round 1, `is_error: false`, `outcome: ok` |
| `input_summary` | `{ field: earth_loop_impedance_ze, confidence: 0.95, board_id: null }` |
| Wire canonicalisation | `Field corrected … earth_loop_impedance_ze → ze` |
| Spoken confirmation | `confirmation_tts_decision { decision: "spoke_inline", text_preview: "Ze 16" }` |
| Client-side divide | `impedance_auto_divided { field: "ze", original: "16", corrected: "1.6", divisor: "10" }` |
| iOS playback ack | source `bundler`, slot `{field: earth_loop_impedance_ze, circuit: 0}` |
| Turn shape | `multi_round`, 2 rounds, `terminal_reason: end_turn`, `tool_names_per_round: [[record_board_reading],[]]` |
| Earthing (dictated turn 2, 07:59:10) | `other thing is TNCS.` ⇒ `earthing_arrangement` = TN-C-S ⇒ **non-TT band `[0.01, 5]`** ⇒ 16 divides to 1.6. Confirms the clamp arithmetic and makes the fixture's `job_state` seeding non-arbitrary. |

**The defect is confirmed verbatim:** spoken `"Ze 16"` alongside stored `1.6`.

**Caveat recorded (honesty pin):** `stage6_tool_call.input_summary` omits the raw `value` (PII leak
filter), so the tool input's `16` is established from `impedance_auto_divided.original` plus the
spoken `"Ze 16"` rather than read directly off the tool input. The field, confidence, board scope,
round index, stop reasons and tool identity all come straight from the capture.

### Corroboration of §2.2 (the causal link to plans A and B)

Turns 6–10 show **five** `clear_reading` attempts on `earth_loop_impedance_ze`, every one rejected
with `{ code: "field_not_clearable" }` — the id-101 "Delete Ze" failure that plans A and B fix. The
bogus `1.6` this plan removes is exactly what Derek was trying to delete.

---

## Execution notes

- Worktree had no `node_modules` (a fresh `git worktree` does not inherit it). `npm ci` run in the
  worktree so the backend Jest and web vitest suites are runnable there — exit 0.

- Tracked-symlink noise: `git status` shows ` D packages/shared-types/node_modules` throughout. That
  path is committed on `main` as a mode-`120000` symlink and `npm ci` replaced it with a real
  directory. **Not this run's change** — left unstaged, never `git add -A`'d. Pre-existing on `main`;
  worth a repo-hygiene follow-up (logged below).
- Verification footgun re-confirmed: plain `grep` on `src/extraction/*.js` matches nothing (multibyte
  em-dash ⇒ classified binary). Used `rg` (which has no `--include` flag) or `grep -a` throughout.

---

## Plan deviations and decisions (each with its reason)

### `[ASSUMED]` / corrections to the plan's own text

1. **Seam C is a PASS-THROUGH on the live path today, not an active clamp.** The plan describes the
   post-completion breadcrumb as a clamp seam. It is wired, and the code is correct, but the only
   schema declaring a `correctionBreadcrumb` today is insulation-resistance, whose megaohm fields sit
   in NO clamp band. So the seam cannot fire in production as shipped. Kept (a future
   continuity-field breadcrumb gets it for free) and pinned by a test that drives a continuity field
   through it, plus a companion test pinning the IR megaohm pass-through as byte-unchanged.
2. **`clearValueCorrection` has NO engine call site.** Exported and tested deliberately: it is the
   designated hook for a clear / script-cancel path, and an untested export is one refactor away from
   being deleted as dead code. Recorded rather than silently kept.
3. **No oracle/runner change was needed for the fixture.** The plan anticipated one. The shadow
   harness already folds `record_board_reading` writes into `extracted_readings` with `circuit: 0`,
   which is the array the oracle reads, so the existing operation matcher covers a supply-scope write
   unchanged.
4. **F/U-4 scope pin widened**, not replaced — `eicr-extraction-session.fu4-supply-ze-canonical.test.js`
   asserted raw supply values survive ingest; the earthing widening adds a key to the same merge, so
   the pin was extended to cover it rather than forked.

### Deliberately NOT done

- **`measured_zs_ohm` is not clamped** and must stay unclamped. `value-enum-validator.js` allows it to
  100 Ω because a long final circuit legitimately reads tens of ohms. Adding it would start silently
  dividing VALID readings — a worse defect than the one being fixed.
- **`out_of_range` behaviour untouched.** Inventing a new backend rejection path risks silently
  dropping a reading (Audio-First #2). The client-side divergence is left open with a dated
  parity-ledger row in PR 2.
- **`wire-emit.js` not modified** (plan §6 do-not-modify). The cycle-3 deliverability fix therefore
  MIRRORS `safeSend`'s gate in `engine.js` instead of making `safeSend` report delivery status.

---

## Codex diff review — 4 cycles, converged to PASS

| Cycle | Findings |
|---|---|
| 1 (3 parallel lenses) | Lens 1 IMPORTANT + Lens 2 BLOCKER: `web/` still clamps `measured_zs_ohm` → **adjudicated WITHIN_INTENT / already-scheduled** (plan §11.3 mandates the two-PR split; a commit touching `src/` and `web/` is a combined deployment). Lens 3 BLOCKER: same-round earthing ordering → **fixed** (`eb5b11f2`). |
| 2 (mini-review of the ordering fix, then full) | Mini-review BLOCKER: the earthing hoist crossed `add_board`/`select_board`, which mutate `snapshot.currentBoardId` — a NEW silent wrong-board write → **fixed** (`419cfe8c`, segment-bounded partition). 2 IMPORTANT: non-discriminating tests → **fixed**, both RED-proven. Full BLOCKER: Seam D, the `start_dialogue_script` backfill built a fresh entry with no Symbol → **fixed** (`42e3e1cc`). Full IMPORTANT: speculator same-round unclamped speculation → **adjudicated a SAFE MISS** (see below), documented + pinned. |
| 3 | 0 BLOCKER, 1 IMPORTANT in two paragraphs. Paragraph (a) — `transitionToConfirmation` consumes the correction ledger BEFORE `safeSend`, which silently returns on a closed socket and reports no success signal → **REAL, fixed** (`5dc04820`, `canDeliver` gate). Paragraph (b) — `engine.js:317` one-shot-clearing `dialogueCorrectionBreadcrumb` → **NOT a finding**: that is a breadcrumb, not the correction ledger; one-shot is REQUIRED (a later utterance could otherwise re-trigger it), the Seam-C correction is consumed inline in the same block and cannot outlive it, and per that block's own COVERAGE NOTE the only schema declaring a breadcrumb today is insulation-resistance, whose fields are in no clamp band. Rejected with reasons. |
| 4 (final) | **PASS** — explicitly no BLOCKER / IMPORTANT / NIT. |

Finding count strictly decreased every cycle (multiple → 4 → 1 → 0), so the convergence check never
tripped; well inside `CODEX_REVIEW_CAP=10`.

### The speculator adjudication, in full (it is a "documented, not fixed")

`onToolUseStreamed` fires the moment a tool-use block finishes streaming, so a speculation is built
from the snapshot AS IT WAS AT STREAM TIME. When earthing and the impedance reading arrive in the
SAME round, the earthing record has not been dispatched yet, `safeEarthing` is the PRE-turn value,
and the speculated line is UNCLAMPED and clause-less.

Structurally unfixable in the hook — buffering until the round's writes are known forfeits the Loaded
Barrel's entire latency purpose. And it needs no fix: `validateAgainstConfirmations` compares the
parked `expandedText` against the bundler's ACTUAL emitted confirmation, the correction clause makes
them differ, the entry is invalidated and dropped, `keys.js` then structurally MISSES (different
`expandedText` ⇒ different cache key) and the clamped line synthesises fresh. Cost = one wasted synth
plus normal TTS latency; the unclamped number is never audible.

**Pinned by a test** because that safety depends on the clause being part of the TEXT IDENTITY: were
a future change to make it a post-synthesis decoration appended AFTER the cache key is computed, a
stale "Circuit 4, Zs 16" would be served from cache over a stored `1.6` — the exact id-100(b) defect,
reintroduced through the cache instead of the dispatcher, and silent without the pin.

---

## RED proofs performed (every discriminating claim was proven, not asserted)

| What | Method | Result |
|---|---|---|
| Corpus fixture `frc_51be8bec…` | replay against unfixed source | `✓ expected RED confirmed: reading.op_ze_clamped` — then flipped `required_green` as a SECOND commit (`evaluateGateState` admits an `expected_red` fixture only when EXACTLY ONE distinct id fails; with the audible oracle present, pre-fix source fails three) |
| Seam D hand-off | neutered the `consumeValueCorrection` hand-off | `2 failed, 2 passed` — exactly the DISCRIMINATING and exactly-once tests failed; the two characterisation pins stayed green, which is correct (they pin invariants the fix must not break, not the fix itself) |
| Cycle-3 `canDeliver` gate | reverted to unconditional consume | `1 failed, 92 passed` — the closed-socket test was the ONLY failure of 93 |
| Board-context bound | mini-review remediation | two independent RED proofs (documented in-cycle) |

---

## Gates (final, on `dcd2832a`)

| Gate | Result |
|---|---|
| Backend Jest (full) | **6214 passed / 19 skipped / 0 failed**, 257 suites |
| Field-replay corpus (strict prepush) | **8/8 pass, 0 unsupported_pending, 0 failed** — `strict gate green` |
| ESLint (changed files) | 0 errors |
| Codex diff review | **PASS** (cycle 4) |

One benign parallel-run flake observed earlier in the run: `jobs.test.js:367` fails under full-suite
parallelism and passes in isolation. Pre-existing, unrelated to this diff, not introduced here.

---

## `[FOLLOWUP]` (5 max — all logged to `~/obsidian-vault/active/todos-certmate.md`)

1. **Make `safeSend` report delivery status.** The cycle-3 fix mirrors `safeSend`'s gate in
   `engine.js` because `wire-emit.js` is on this plan's do-not-modify list. RESIDUAL: an OPEN socket
   whose `send` THROWS still consumes the correction ledger. Closing it needs `safeSend` to return a
   delivery boolean — a wire-emit change touching every emit site in the engine.
2. **Dialogue Seams A/B do not emit `stage6.impedance_clamp_applied`.** `applyWrite` /
   `normaliseDialogueSlotWrite` take no logger, and threading one through the twelve `applyWrite`
   invocations is a bounded change, not part of a safety fix. Those clamps stay observable via the
   script's own `logger.info` (which reports the STORED value) and via the named read-back.
3. **iOS/web `out_of_range` divergence** (owner: Derek, per plan §4.6). The backend writes an
   out-of-range value unchanged and says nothing; the clients differ. Needs a cross-platform decision,
   not a unilateral backend rejection path.
4. **`packages/shared-types/node_modules` is a committed symlink** (mode `120000`) on `main`. `npm ci`
   replaces it with a real directory, so every worktree shows a spurious ` D` in `git status`.
   Repo-hygiene fix: untrack it and add to `.gitignore`.
5. **Post-deploy ear-verification of the named correction.** The clause "Ze recorded as 1.6 — I
   corrected 16 to 1.6" is the audit mechanism for the clamp itself; it has been pinned byte-exact in
   tests and the corpus but not yet HEARD in the field. One live probe after the ECS rollout.

---

## Deliverables

- **PR 1 (this branch):** backend + tests + recorded fixture + docs. 18 commits.
- **PR 2 (web, separate):** remove `measured_zs_ohm` from `apply-extraction.ts`'s clamp map (the
  discriminating web test FAILS on unfixed `main`), plus an explicitly-labelled CHARACTERISATION pin
  for the now-inert no-op (plan §4.9 Round-5 IMPORTANT: as written it CANNOT fail on `main` and must
  not be counted as change-proving), plus parity-ledger rows
  (`recording/impedance-clamp-readback` → `partial`, owner Derek; a second dated row for the
  `out_of_range` divergence).
- **iOS:** `session_ack` decode + capability latch + ownership-aware `.divided` → speak, slot-identity
  unification. Explicitly NOT an `applyRegexMatches` clamp (that function performs no circuit write).
  `CertMateUnified/` is a separate nested repo, absent from this worktree; plan §11.5 sequences its
  TestFlight build with wave plans C and G.
