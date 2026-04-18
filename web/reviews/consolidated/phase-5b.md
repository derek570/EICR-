# Phase 5b — Consolidated Review

**Commit:** `766735f` — Wire the "Extract" button on the Circuits action rail to `/api/analyze-document`; fold the returned envelope into `JobDetail` non-destructively via a new `apply-document-extraction.ts` (422 LOC).

---

## 1. Phase Summary

Phase 5b wires a previously-stubbed Extract rail button on the Circuits tab to the pre-existing `/api/analyze-document` GPT-Vision endpoint. A new merge helper (`web/src/lib/recording/apply-document-extraction.ts`) applies a strict fill-empty-only policy across installation, supply, board, circuits, and observations — explicitly stricter than iOS's `CertificateMerger.merge()`. Circuit matching is by case-insensitive `circuit_ref`; observation dedupe mirrors iOS (`schedule_item+code` OR `location + 50-char text prefix`). Response types are permissive (`[key: string]: unknown`). PDF support, cable defaults, and `recalculateMaxZs` are deliberately deferred. Commit is small, well-commented, and hews to the plan.

---

## 2. Agreed Findings

| # | Severity | Area | File:Line | Finding |
|---|----------|------|-----------|---------|
| A1 | P1 | Correctness (state churn / dead code) | `web/src/lib/recording/apply-document-extraction.ts:176, 205` | `mergeBoard()` clones `boardState.boards` unconditionally, so the `boards === boardState.boards` reference-equality guard at :205 can never hold. No-op board reads still emit a board patch, marking the job dirty and forcing spurious rerenders. Fix by tracking a real `boardChanged` boolean and returning `null` when nothing changed. |
| A2 | P1 | Code quality / type safety | `web/src/lib/types.ts:216-230` + `apply-document-extraction.ts:307, 347` | `ObservationRow` does not declare `schedule_item` / `regulation`, yet the helper reads and writes them via `as unknown as Record<string, unknown>` casts. Dedupe key drift is invisible to TypeScript; a rename silently breaks dedupe. Widen `ObservationRow` to include both fields and drop the casts. |
| A3 | P2 | Test coverage | `web/src/lib/recording/apply-document-extraction.ts` (entire module) | No unit tests for the 422-LOC merge helper. Needed: fill-empty-only semantics per section, circuit ref case-folding, observation dedupe (both OR'd rules), board synth vs match, `success:false` / malformed envelope handling, idempotent re-run. |

---

## 3. Disagreements + Adjudication

| # | Topic | Claude | Codex | Adjudication |
|---|-------|--------|-------|--------------|
| D1 | Overall verdict | Ship with follow-ups (no P0). | Needs rework (stale-state race is data-loss). | **Ship with follow-ups, elevated.** Codex's stale-state concern (see D2) is real but mitigated by the fact that the Extract flow is a single 2-8 s await while the user is typically looking at a progress hint — realistic overlap of in-flight user edits on the same section is small. Claude's verdict is closer to right, but the race should be upgraded from "not mentioned" to a P1 follow-up because the feature is explicitly sold as "safe to run after the inspector has started typing" (commit body). Net verdict: ship, with race fix scheduled before multi-inspector or slow-network field use. |
| D2 | Stale-closure race in `updateJob` | Not raised. | P1 — patch computed from closure snapshot then applied via shallow `setJob(prev => ({...prev, ...patch}))`; user edits to `installation`/`supply`/`circuits`/`observations` during the 2-8 s upload window get clobbered. | **Codex correct.** Verified at `circuits/page.tsx:182-195` and `job-context.tsx:55-58`. `updateJob(patch)` overwrites whole sections (e.g. `patch.circuits` is the full array) and `setJob` reads `prev` but the patch itself was derived from the stale `job`. Fix: either pass a reducer (`updateJob(prev => applyDocumentExtractionToJob(prev, response, ...))`) or re-read state via a ref at commit time. Claude missed this entirely. |
| D3 | `polarity_confirmed` / `rcd_button_confirmed` coercion gap | P1 — backend coerces boolean → `"✓"`/`""`; UI SegmentedControl only understands `pass/fail/na`. Data lands in a field UI can't display and PDF can't interpret. | Not raised. | **Claude correct; verified.** `src/routes/extraction.js:1484-1489` converts booleans to `"✓"`/`""`. `web/src/app/job/[id]/circuits/page.tsx:64-68, 689-694` defines and uses a SegmentedControl with only `pass/fail/na` options. `apply-document-extraction.ts:246-252` copies values untranslated. User-visible as blank pill + opaque `"✓"` round-tripping to PDF. Codex missed a concrete user-facing data gap. |
| D4 | Circuits missing `circuit_ref` silently dropped | Mentioned only in passing (P2-1 about ref-key schema split). | P2 — row silently discarded at `:236-238`; partially legible prior certs lose designation/OCPD/RCD/test data with no warning. | **Codex correct.** Verified at `apply-document-extraction.ts:236-238`. At minimum, count skipped rows in the `summary` so the hint says "Document read — 3 circuits merged, 2 skipped (no ref)". Optionally quarantine in a synthesized ref bucket. Confirm as P2. |
| D5 | `response.success` never checked vs helper comment claim | Not raised. | P2 — helper docstring (`:370-372`) claims `success:false` returns empty patch; code never checks `response.success`. Latent because backend currently returns non-2xx on failure, but contract drift is possible. | **Codex correct.** Verified at `apply-document-extraction.ts:374-382`. Either add `if (!response?.success) return empty` or correct the comment. P2/docs-correctness. |
| D6 | `installation_records_available` / `evidence_of_additions_alterations` use strict `!== undefined` instead of `hasValue()` | P1-4 — inconsistent with every other install guard; `null` from JSONB round-trip would overwrite user `false`. | Not raised. | **Claude correct (minor).** Downgrade to P2 — requires a `null` value in the JSONB round-trip to trigger, which has not been observed but is a defense-in-depth gap. Worth a 1-line fix for consistency. |
| D7 | Client-side MIME / size validation | P1-5 — no size cap, HEIC undefined-behaviour vs hard-coded `data:image/jpeg;base64,...` at backend `:1425`. | Not raised. | **Claude correct, but downgrade to P2.** The failure mode is "upload is slow / GPT Vision may reject or quietly handle" — not data corruption. Add a ≤10 MB guard and optional canvas downscale as a polish item. |
| D8 | A11y polish (dual `role="alert"`, `aria-busy`, `aria-hidden` on focusable input, file-picker label) | Six A11y-1..A11y-6 items, mostly P2. | "No major a11y regressions." | **Claude correct on the substance** (confirmed at `:306-322`, `:407`, `:278/:294`), but agree with Codex these are polish — no WCAG-AA blocker. Treat as a batched a11y sweep follow-up rather than blocking. |

---

## 4. Claude-Unique Findings

- **C1 [P1]** `polarity_confirmed` / `rcd_button_confirmed` server→UI enum gap (verified — see D3). **Highest-leverage bug in the review.**
- **C2 [P1]** `installation_records_available` / `evidence_of_additions_alterations` use `!== undefined` rather than `hasValue()` — inconsistent with rest of the helper.
- **C3 [P1]** No client-side file size / MIME guard on the Extract picker; HEIC on iOS Safari round-trips in full.
- **C4 [P2/a11y]** Six a11y polish items: dual `role="alert"` regions indistinguishable, Extract button loses its label when busy (no `aria-busy`/explicit `aria-label`), `aria-hidden` on a focusable `<input>`, no `aria-haspopup` / file-picker label hint, unconditional `animate-spin` vs `prefers-reduced-motion`.
- **C5 [P2]** `setExpandedId` never called for newly-merged circuits → inspector has no quick way to verify what was filled.
- **C6 [P2]** Summary hint says "no new data" when only installation/supply/board merged (counts only track circuits/observations). Track section-level changes via `Object.keys(patch).length > 0`.
- **C7 [P2]** Duplicated `globalThis.crypto?.randomUUID?.() ?? ...` pattern (3× in this file, also in `apply-ccu-analysis.ts` and `apply-extraction.ts`) — extract to `newId(prefix)`.
- **C8 [P2]** `Circuit` type in `circuits/page.tsx:49` (`Record<string, string|undefined>`) is narrower than `CircuitRow` (values can be `unknown`); type confusion when CCU sets booleans.
- **C9** Cosmetic plan-vs-code drift: commit body says "noted with TODO near the file input" but code has only an explanatory comment with no `TODO` token.

---

## 5. Codex-Unique Findings

- **X1 [P1]** Stale-closure race during async extraction overwrites in-flight user edits (verified — see D2). Directly contradicts the commit body's "safe after typing has started" claim.
- **X2 [P2]** Circuits without `circuit_ref` silently dropped at `:236-238` — lossy for partially legible certs.
- **X3 [P2]** `success: false` helper comment does not match behaviour (code never checks `response.success`).
- **X4 [Content]** Empty-state copy at `circuits/page.tsx:348` still mentions only CCU Photo, not document extraction — small UX gap.

---

## 6. Dropped / Downgraded

- **Claude P1-5 (file size / HEIC)** → Downgraded to **P2**. Failure mode is slow upload / GPT Vision behaviour, not corruption. Still worth a 10 MB guard.
- **Claude P1-4 (`!== undefined` vs `hasValue`)** → Downgraded to **P2**. Requires explicit JSONB `null` round-trip to trigger; not observed.
- **Claude A11y-1..A11y-6** → Batched as a single **P2 a11y polish** follow-up. No WCAG-AA blocker in this phase.
- **Claude P2-1 (`row.number` fallback)** → Kept as note, not actioned — consistent with 5a and flagged there.
- **Claude "malformed envelope" test case** (section 8) — subsumed by Codex X3, which makes the code-vs-comment drift the real issue, not the missing test.
- **Codex "whole-array replacement amplifies rerenders"** → Informational. Current scale (≤50 circuits / ≤50 observations) makes this a non-issue; only relevant in combination with D2.

---

## 7. Net Verdict + Top 3

### Net Verdict: **Ship with follow-ups (elevated).**

The feature is directionally strong, plan-aligned, and introduces no P0 / security / data-loss-on-happy-path issues. Two real correctness bugs are user-reachable the first time the feature is exercised against a realistic cert photo:

1. the `polarity_confirmed` / `rcd_button_confirmed` coercion gap (Claude),
2. the stale-closure race that clobbers concurrent user edits (Codex).

Both are fixable in a small patch and neither blocks landing the commit, but they must be scheduled as immediate follow-ups before this feature is relied on in the field.

### Top 3 Priorities

1. **Fix `polarity_confirmed` / `rcd_button_confirmed` coercion** (C1 / D3).
   Add a `coercePolarity()` helper inside `mergeCircuits` mapping `{"✓","true","yes","pass"}` → `"pass"`, `{"false","no","fail"}` → `"fail"`, `""` → untouched. Without this, the first Extract on a cert with visible polarity columns writes `"✓"` into a field the UI cannot render and the PDF pipeline does not understand.

2. **Eliminate the stale-snapshot overwrite race** (X1 / D2).
   Change `applyDocumentExtractionToJob(job, response, ...)` to take a setter/reducer so the merge runs against the latest `job` at commit time, not the 2-8 s-stale closure snapshot. Either extend `updateJob` to accept a functional form (`updateJob(prev => nextPatch(prev))`) or re-read state via a ref before dispatching. This is the only way to honour the commit body's "safe after typing has started" claim.

3. **Add focused tests for `apply-document-extraction.ts`** (A3).
   Minimum surface: fill-empty-only semantics per section; circuit ref case-folding + missing-ref skip count; observation dedupe (both OR'd rules); `mergeBoard` no-op returns `null` (once A1 is fixed); polarity coercion (once #1 is fixed); `success:false` / malformed envelope returns empty patch (once X3 is fixed). Single vitest file, ~200 LOC, catches future backend-prompt drift and keeps the merge contract honest.

Everything else — type-safety widening (A2), circuit-ref-drop UX (X2), a11y sweep (C4), size/MIME guard (C3), hint-summary polish (C6), `newId` extraction (C7) — can land in a single follow-up PR alongside the above.
