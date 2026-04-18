# Phase 5a — Consolidated Review

**Commit:** `35b5310` — CCU photo capture + GPT Vision merge on Circuits tab.

Consolidates `reviews/claude/phase-5a.md` and `reviews/codex/phase-5a.md` against the source at commit `35b5310`. No source modifications made.

---

## 1. Phase summary

Phase 5a wires the previously-stubbed CCU rail button on the Circuits tab to a real capture-first file picker (`<input type="file" capture="environment">`), posts the image to `/api/analyze-ccu` via a new `api.analyzeCCU(photo)` multipart helper, and merges the response into the active `JobDetail` via a new `applyCcuAnalysisToJob` helper (367 lines in `web/src/lib/recording/apply-ccu-analysis.ts`). The merge ports the iOS `FuseboardAnalysisApplier.hardwareUpdate` semantics: overwrite hardware (board identity, main switch, SPD), preserve manually-typed values via `hasValue`, preserve any existing circuit that has test readings even if the analyser omits it, and auto-generate "What is the RCD type for circuit X?" questions for unresolved RCD-protected circuits. The Circuits tab surfaces a spinner on the rail button during analysis, an `actionHint` status line, an error banner (`role="alert"`), and dismissible question chips. The backend endpoint was already live for iOS and is unchanged.

Both reviewers agree the port is faithful to iOS and the UI affordances are appropriate. The merge helper is the main risk surface: a stale-closure bug can drop user edits made during the 2–6s await, and `ccu_analysis` is stored as a single unscoped blob so multi-board jobs lose prior analyses. There are no automated tests for the merge.

---

## 2. Agreed findings

| # | Severity | Area | File:line | Finding |
|---|---|---|---|---|
| A1 | P0 | Correctness | `web/src/app/job/[id]/circuits/page.tsx:130-145` + `web/src/lib/job-context.tsx:55` | Stale-closure `job` during the CCU await. `handleCcuFile` captures `job` at render time, awaits the multipart POST (2–6s), then computes `applyCcuAnalysisToJob(job, analysis, …)` from the stale snapshot and shallow-merges whole section bags (`board`, `supply`, `circuits`, `ccu_analysis`) back via `updateJob(patch)`. Any typing the inspector does during the wait is silently clobbered — the `hasValue` per-field guard is defeated by the outer section-level shallow overwrite. Fix: expose a functional `updateJob(prev => partial)` or hold a `jobRef` and read latest inside the async handler. |
| A2 | P0 (Claude) / P1 (Codex) — **Adjudicated P0** | Correctness | `web/src/lib/recording/apply-ccu-analysis.ts:357-359` | `patch.ccu_analysis = analysis` is a total replacement, not namespaced by board. Re-shooting a second board on a multi-board install destroys the first board's stored analysis. Directly breaks the commit-message goal of "review/retry without re-uploading". Fix: `patch.ccu_analysis = { ...(job.ccu_analysis ?? {}), [boardId]: analysis }`. Adjudicated P0 because it is a silent data-loss bug on any multi-board job, with the same severity class as A1. |
| A3 | P2 | Correctness / Type contract | `web/src/lib/types.ts:268-274` + `web/src/lib/recording/apply-ccu-analysis.ts:122` | `main_switch_type`, `main_switch_poles`, and `main_switch_position` are typed on `CCUAnalysis` but never consumed by `buildBoardPatch`. Either wire them into board fields or drop the type entries to keep the contract honest. |
| A4 | P2 | Correctness / Schema drift | `web/src/lib/recording/apply-ccu-analysis.ts:35` + `web/src/app/job/[id]/circuits/page.tsx:57-62` | `VALID_RCD_TYPES` admits `AC/A/B/F/S` (Codex also notes `A-S/B-S/B+` accepted elsewhere via normalisation), but the `RCD_TYPES` chip set only offers `AC/A/B/F`. Imported `S` (and potentially `A-S/B-S/B+`) becomes invisible/uneditable in the chip UI. Either extend chip options or narrow the normaliser. |
| A5 | P1 | Correctness | `web/src/lib/recording/apply-ccu-analysis.ts:143-149` | `spd_status` / `spd_type` writes are unguarded — when `spd_present` is a boolean they are assigned directly (`next.spd_status = 'Fitted' / 'Not Fitted'`, `next.spd_type = 'N/A'`) without a `hasValue(existing[key])` gate. An inspector's manual `'Not Required'` or similar is silently overwritten on every CCU pass. |
| A6 | Low | Accessibility | `web/src/app/job/[id]/circuits/page.tsx:335-339` | Every dismiss chip has the same accessible name `"Dismiss question"`, so screen readers cannot disambiguate. Include the question text or circuit ref. Claude additionally notes the 20px (`h-5 w-5`) hit target is below the 44×44 iOS minimum. |
| A7 | P1 (Claude) / Gap (Codex) | Testing | No file — absence | No automated tests for `applyCcuAnalysisToJob`, `handleCcuFile`, or the CCU rail. 367 lines of branchy merge logic with zero unit coverage. Both reviewers list essentially the same required cases: stale-state rebase, multi-board analysis storage, unmatched-circuit preservation, valid RCD types outside `AC/A/B/F`, board-model field mapping. |

---

## 3. Disagreements + adjudication

**D1. `ccu_analysis` overwrite severity — P0 (Claude) vs P1 (Codex).**
Claude flags it P0; Codex P1. Adjudicated **P0**. The commit message explicitly cites review/retry preservation as a goal, and the failure mode is silent data loss across multi-board jobs (not merely a UX nit). Fix effort is trivial (one-line object-spread), which is an additional argument for treating it as blocking.

**D2. `board_model` → `board.name` mismapping — Codex-unique P2, not raised by Claude.**
Verified via Read on `web/src/app/job/[id]/board/page.tsx:148-162`: the Board identity card has *both* a `Name` (line 150) and a `Model` (line 160) input. The merge at `apply-ccu-analysis.ts:119-120` writes `analysis.board_model` into `next.name`, leaving the Model input empty. Adjudicated **valid P2** — finding retained under "Codex-unique". Claude's review covered board fields at the section level but missed this specific field-name drift.

**D3. "RCBO chip missing" (Claude P1-4) vs "RCD_TYPES subset" (Codex P2).**
These overlap but are distinct: Claude's point is that the helper writes the literal `'RCBO'` into `rcd_type` on line 318 but the chip list doesn't include `RCBO`. Codex's point is that `S/A-S/B-S/B+` are accepted by the normaliser but also absent from the chips. Both are real; merged into A4 above with the broader framing, and Claude's `'RCBO'` sub-point retained under "Claude-unique" so the specific writer-side fix is not lost.

**D4. Stale-closure severity phrasing.**
Both reviewers P0 it; no disagreement. Listed once under Agreed (A1).

---

## 4. Claude-unique findings

| # | Severity | Area | File:line | Finding |
|---|---|---|---|---|
| C1 | P1 | Correctness | `web/src/lib/recording/apply-ccu-analysis.ts:181-191` | Supply-patch dead-write / ordering fragility. The `for` loop writes `next[key] = 'N/A'` when `spd_present === false`, then the subsequent `apply('spd_rated_current', …)` / `apply('spd_type_supply', …)` calls gate on `hasValue(existing[key])` (not `hasValue(next[key])`) so an N/A just written can be stomped by a subsequent main-switch fallback. Brittle — at minimum align `apply` to read `next`, or collapse to a single pass. |
| C2 | P1 | Correctness | `web/src/lib/recording/apply-ccu-analysis.ts:207-212` | Cross-board circuit leakage for `board_id == null` rows. Orphan circuits are adopted by whichever board runs CCU, so on two-board jobs an orphan can hop between boards on successive CCU runs. Invariant not enforced. |
| C3 | P1 | Correctness | `web/src/app/job/[id]/circuits/page.tsx:57-62` + `apply-ccu-analysis.ts:318` | Merge helper writes literal `'RCBO'` into `rcd_type` for resolved RCBOs with no type, but the `RCD_TYPES` chip set (`AC/A/B/F`) cannot render or re-emit `'RCBO'`. Value becomes invisible in the editor. |
| C4 | P1 | Correctness / UX | `web/src/app/job/[id]/circuits/page.tsx:240` | `ccuQuestions` is not cleared when the board selector changes, so chips from Board 1 persist visually after switching to Board 2. |
| C5 | P1 | Correctness / UX | `web/src/lib/api-client.ts:161-168` + `circuits/page.tsx:130-171` | No client-side upload-size guard. Backend rejects at 20MB (`CCU_MAX_UPLOAD_BYTES`). Modern iPhone JPEGs can be 10–15MB and HEIC conversions larger; the inspector waits for a slow-network upload to see a 413. Suggest `file.size` short-circuit + optional canvas downscale for >8MB. |
| C6 | P2 | Correctness / UX | `web/src/lib/types.ts:285-296` | `confidence` and `gptVisionCost` are in the type but discarded by the UI. iOS surfaces a low-confidence banner + cost log. |
| C7 | P2 | Code quality | `web/src/lib/recording/apply-ccu-analysis.ts:258, :293` | Duplicate `analysed.label === 'null'` string checks — analyser sometimes emits the literal `"null"`. Extract to a helper so future callers can't regress. |
| C8 | P2 | Code quality | `web/src/lib/recording/apply-ccu-analysis.ts:203-204` | `buildCircuitsPatch` returns `null` on empty incoming circuits, so an analyser that returned no devices but changed SPD data won't re-write the circuits section. Flag the edge. |
| C9 | Security / info | `web/src/app/job/[id]/circuits/page.tsx:162-166` | Server error bodies are interpolated whole into the on-screen banner. React escapes text, so no XSS, but a 500 with a stack would leak to the user. Consider clipping to first line / 160 chars. |
| C10 | Perf | `web/src/app/job/[id]/circuits/page.tsx:452` + job-context shallow merge | `CircuitCard` is not memoised; every CCU merge creates fresh refs for all circuit rows, forcing a full `FloatingLabelInput` re-render across all cards. Material at 60+ circuits. |
| C11 | A11y | `web/src/app/job/[id]/circuits/page.tsx:300, :338-339` | (a) Consider explicit `aria-live="polite"` on the `actionHint` paragraph in case `role="status"` is dropped by a future variant. (b) Dismiss button hit area 20px — below 44×44 iOS minimum. |
| C12 | Code quality | `web/src/lib/recording/apply-ccu-analysis.ts:94-95` + `circuits/page.tsx:92-93` | `boards` is double-cast via a local `BoardRecord` + inline `{ boards?: {…}[] }` types at both call sites. Centralise in `types.ts`. |
| C13 | Code quality | `web/src/lib/types.ts:213` | `CircuitRow` uses `[key: string]: unknown`, hiding typos in reading keys at compile time. Narrow to known keys + `extras?: Record<string, unknown>`. |
| C14 | Code quality | `apply-ccu-analysis.ts:101, :291` + `circuits/page.tsx:72` | Duplicated inline `globalThis.crypto?.randomUUID?.() ?? \`board-${Date.now()}\``. Extract a `newId(prefix)` helper. |
| C15 | Code quality | `apply-ccu-analysis.ts:68` | `mergeField` generic `<T>` is neutered by string casts at call sites — generic adds no safety. Either drop or type natively. |
| C16 | Code quality | Merge helper `normaliseRcdType` vs prompt enum | `VALID_RCD_TYPES` is wider than the typed `CCUAnalysisCircuit.rcd_type` enum and the hyphen/space handling in the regex doesn't cover `'A S'` → `'AS'`. Align regex + enum. |
| C17 | Persistence gap | `updateJob` / `api.saveJob` | `updateJob` does not call `api.saveJob` (Phase 4 item). A CCU merge lives only in memory until the user reloads — at which point it is lost. The error-banner copy "no data lost" is misleading given this. Document or trigger a save. |

---

## 5. Codex-unique findings

| # | Severity | Area | File:line | Finding |
|---|---|---|---|---|
| X1 | P2 | Correctness / Schema drift | `web/src/lib/recording/apply-ccu-analysis.ts:119-120` + `web/src/app/job/[id]/board/page.tsx:148-162` | `analysis.board_model` is mapped into `board.name`, but the Board editor has a separate `Model` field. Imported model lands in the wrong slot and the real Model input stays empty. Verified via Read: the board page renders both `Name` and `Model` floating-label inputs as distinct fields. Fix: map `board_model` → `board.model` (or populate both if legacy consumers still read `name`). |
| X2 | Perf | `web/src/lib/recording/apply-ccu-analysis.ts:153` | `buildBoardPatch` always returns a fresh `board` object even when nothing changed, causing unnecessary dirty-state churn and rerenders. |

---

## 6. Dropped / downgraded

- **Claude P1-6 (ccuQuestions clearing on re-run).** Claude self-downgraded mid-finding: the setState wholesale-replace on a second CCU upload is actually correct; only the board-selector case remains. Retained as C4 (the board-selector sub-point), dropped the "re-run clears" worry.
- **Claude §4-1 (client MIME check) / §4-2 (blob URL) / §4-3 (XSS) / §4-4 (auth) security pass.** No finding generated; these are explicit confirmations that the phase is clean on those vectors. Not carried forward as issues.
- **Claude §5-2 (double-fire debounce) / §5-3 (server-side resize) / §5-4 (streaming).** Non-issues per Claude's own review. Dropped.
- **Codex §4 security / §5 perf headline.** "No phase-specific defect" — nothing to carry.

No findings were *downgraded* on severity aside from the explicit adjudication of A2 as P0 (which was an *upgrade* from Codex's P1).

---

## 7. Net verdict + top 3

**Net verdict: Approve with blocking changes (P0s + at least one test case).**

The port of the iOS hardware-update merge is structurally correct and well-reasoned, parity with iOS is well-documented in the commit body, and the UI affordances (capture-first picker, spinner on the rail button, `role="alert"` error banner, dismissible question chips) are appropriate. But two correctness bugs (A1 stale closure, A2 unscoped `ccu_analysis`) are silent data-loss bugs that will bite a real inspector on a real multi-board site, and 367 lines of branchy merge logic have zero unit coverage. Land the P0s + minimum test matrix before customer exposure.

**Top 3 priorities (in order):**

1. **Fix the stale-closure merge (A1) and the unscoped `ccu_analysis` overwrite (A2).** Change `updateJob` to support a functional updater or hold a `jobRef`; namespace `ccu_analysis` by `boardId`. Both are small diffs and both prevent silent data loss.
2. **Add unit tests for `applyCcuAnalysisToJob`** covering, at minimum: empty-job merge, readings preserved on matched circuit, data-loss guard on omitted-with-readings circuit, SPD manual-override preservation (A5 regression), multi-board `ccu_analysis` retention (A2 regression), RCBO / `S` round-trip through the chip UI (A4/C3), stale-state rebase (A1 regression).
3. **Close the UI/contract drift trio:** gate `spd_status` / `spd_type` writes with `hasValue` (A5), map `board_model` → `board.model` not `board.name` (X1), and reconcile `RCD_TYPES` chip options with `VALID_RCD_TYPES` (A4) — either extend chips to include `S/A-S/B-S/B+/RCBO` or narrow the normaliser. Each is cheap; together they remove three silent-overwrite / invisible-value traps.
