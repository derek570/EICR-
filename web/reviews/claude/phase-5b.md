# Phase 5b Review — Document Extraction on Circuits Tab

**Commit:** `766735f`
**Scope:** Wire the "Extract" button on the Circuits action rail to `/api/analyze-document`; fold the returned envelope into `JobDetail` non-destructively.

---

## 1. Summary

Phase 5b wires a previously-stubbed rail button to a pre-existing backend endpoint (`/api/analyze-document`), introducing one net-new merge helper (`apply-document-extraction.ts`, 422 LOC) and a permissive response type. The implementation reuses plumbing from Phase 5a (CCU) with high fidelity — file-input pattern, busy/error state shape, board synthesis idiom, action-hint copy. The merge policy is explicitly stricter than iOS (fill-empty-only across *all* sections vs iOS's overwrite-on-installation/supply/board), which is the documented Phase 5 intent and is consistent with the recording extractor.

Overall the change is small, well-commented, and hews to the plan. The main correctness concerns are (a) server-side boolean-to-glyph coercion of `polarity_confirmed`/`rcd_button_confirmed` landing in a UI expecting `pass/fail/na`, (b) subtle dead-code in the board-merge short-circuit, (c) observation dedupe schema drift (reads `schedule_item` via an unsafe cast onto the typed `ObservationRow`, then writes it back via the same cast), and (d) accessibility gaps on the dual error regions and the busy-state rail button. No P0 security or data-loss issues.

---

## 2. Alignment with Plan / Handoff

- **Plan vs commit:** Plan-to-code alignment is high. The commit-body checklist matches what is on disk; the `TODO: PDF support` reference in the commit body is not actually present in the wired `<input>` element (`circuits/page.tsx:288-295` has a comment, no `TODO` marker), but the plan content is there.
- **Stricter-than-iOS priority:** Confirmed. `apply-document-extraction.ts:117-118` (installation), `:157` (supply), `:199` (board), `:248` (circuits) all call `hasValue(...)` before overwriting — matches handoff § "3-tier priority guard applied everywhere".
- **Circuit merge by `circuit_ref` only:** Confirmed (`:231`). Levenshtein fuzzy matcher explicitly skipped — consistent with 5a.
- **Observation dedupe rules:** Port is faithful to iOS `CertificateMerger.swift:100-122` — `(schedule_item + code)` OR `(location + 50-char text prefix)` (`:329-333`).
- **No `capture="environment"` on doc input:** Confirmed (`circuits/page.tsx:288-295`).
- **Permissive response types:** Confirmed — `DocumentExtractionCircuit`, `DocumentExtractionObservation`, `DocumentExtractionFormData` all use `[key: string]: unknown` (`types.ts:338, 347, 356`).
- **Deferred items:** PDF support, cable defaults, recalculateMaxZs — all deferred as documented.

**Minor divergence:** The plan says "noted with TODO near the file input" for PDF support — the code has an explanatory comment (`circuits/page.tsx:284-287`) but no `TODO:` token, so `grep TODO` won't surface it. Cosmetic.

---

## 3. Correctness

### P0 — data-loss or crash

None identified.

### P1 — behavioural correctness gaps

**P1-1. Server's `polarity_confirmed` / `rcd_button_confirmed` coercion is incompatible with the UI state machine.**
Backend at `src/routes/extraction.js:1482-1495` converts booleans to `"✓"` (truthy) or `""` (empty). The web UI's `SegmentedControl` only understands `"pass"`, `"fail"`, `"na"` (`circuits/page.tsx:64-68, 689-694`). When `mergeCircuits` fills an empty circuit's `polarity_confirmed` field with `"✓"`, the segmented control will render no pill active and the value will round-trip back to `saveJob` as `"✓"`. That value then flows into the PDF generator. Two failure modes:
  - Display: inspector sees a "blank" polarity even though the field is populated.
  - Data: the string `"✓"` is not a meaningful enum for downstream PDF generation / CSV export.

Note the `""` case is fine because `hasValue("")` → false, so empty overwrites never happen. But `"✓"` and the string `"true"`/`"false"` (also possible per backend prompt line 1406) flow through untranslated. Recommended: add a `coercePolarity()` that maps `{"✓","true","yes","pass"}` → `"pass"`, `{"false","no","fail"}` → `"fail"` inside `mergeCircuits`.

**P1-2. Dead condition in `mergeBoard`.**
`apply-document-extraction.ts:176` does `const boards: BoardRecord[] = boardState.boards ? [...boardState.boards] : [];` — always a new array. Then `:205` checks `if (!changed && boards === boardState.boards) return null;`. Reference equality can never hold because of the spread. This means a no-op call where `boardState.boards` exists and nothing matched will still return a patch (the code does not hit `return null` and instead returns a `{ board, boardId }` payload with an unchanged `boards` array). Downstream, line 396 then sets `patch.board = boardResult.board`, causing a spurious re-render. Low-severity but worth fixing — replace with `if (!changed) return null;` (the no-initial-incoming case is already handled at `:184`).

**P1-3. Observation dedupe reads/writes `schedule_item` via unsafe casts onto `ObservationRow`.**
`ObservationRow` in `types.ts:216-230` does not declare `schedule_item` or `regulation`. The code accesses them via `(row as unknown as Record<string, unknown>).schedule_item` at `apply-document-extraction.ts:307` and writes via `(newRow as unknown as Record<string, unknown>)` at `:347-349`. Consequences:
  - Existing observations with `schedule_item` set by a prior extract will be read correctly, but any observation created by the recording pipeline (`apply-extraction.ts:251-256`) never sets `schedule_item`, so the dedupe rule `(schedule_item + code)` will never fire for mixed-source observations even when the underlying defect is identical.
  - TypeScript cannot catch typos on this passthrough — a rename to `scheduleItem` would silently break dedupe.
Recommended: widen `ObservationRow` in `types.ts` to declare `schedule_item?: string; regulation?: string;` (both already round-trip through `saveJob` because the backend preserves unknown keys).

**P1-4. `installation_records_available` / `evidence_of_additions_alterations` guard uses strict `undefined`, not `hasValue`.**
`apply-document-extraction.ts:138` — `if (existing[key] !== undefined) continue;`. If an upstream write ever persists `null` (which PostgreSQL JSONB round-trips produce for explicit nulls), the extractor would overwrite a user-entered `false`. All other installation guards use `hasValue()`. Unify on `hasValue()` for consistency and defence-in-depth.

**P1-5. No MIME / size validation client-side.**
The `<input>` at `:288-295` accepts `image/*`, but there is no size check and no explicit rejection of HEIC/AVIF/etc. Users on iOS Safari can select a 30 MB HEIC — the backend accepts up to 100 MB and HEIC is in `IMAGE_MIMES` (`src/utils/upload.js:9`), so it will technically work, but the backend reads the file then passes `data:image/jpeg;base64,...` regardless (`extraction.js:1425`) to GPT Vision. GPT Vision tolerates the wrong MIME label for non-JPEG bytes in practice, but this is undefined behaviour (the plan comment even says "backend hard-codes image/jpeg"). Recommended: add a client-side size guard (~10 MB) and either (a) convert HEIC → JPEG client-side, or (b) add a "still converting…" affordance in the busy state.

### P2 — quality / robustness nits

**P2-1.** `mergeCircuits` falls back to `row.number` as ref key (`:230`), mirroring 5a, but newly-appended rows only set `circuit_ref` — not `number`. That's fine for this commit but widens the schema split already flagged in the 5a review.

**P2-2.** `setExpandedId` is never called for newly-merged circuits. 5a behaves the same, so this is consistent — but the "Document read — N circuits merged" hint leaves the user no quick way to verify what was filled. Consider expanding the first new circuit.

**P2-3.** `applyDocumentExtractionToJob:398-407` uses an IIFE fallback for `boardId`. Reads fine, but an explicit `else` branch would be more scannable.

**P2-4.** The doc success hint at `:210-212` says "Document read — X circuits, Y observations merged". When both counts are zero but the installation/supply/board section merged, the hint says "Document read — no new data." even though installation fields were filled. The summary only tracks circuits/observations counts. Consider a bitmask or derived flag from `Object.keys(patch).length > 0`.

**P2-5.** `handleDocFile` does not clear the prior `actionHint` before setting "Reading document…" — if a CCU was just analysed, there is a 0-frame flash where both hints appear; practically invisible but the state transition is underspecified.

---

## 4. Security

- **Auth:** All calls go through `request()` which attaches the bearer token (`api-client.ts:37-38`); `/api/analyze-document` requires `auth.requireAuth` on the server (`extraction.js:1251`). Fine.
- **SSRF / SSRF-like:** No. Client POSTs a file, server reads from its own tmp.
- **MIME sniffing / polyglot uploads:** The backend uses multer's `fileFilter(IMAGE_MIMES)` which trusts the claimed MIME type (multer's fileFilter reads only the `Content-Type` header, not magic bytes). A malicious user could send a crafted HTML/JS file with `Content-Type: image/jpeg`; GPT Vision would presumably reject it but the server still spends an OpenAI call. Not introduced by 5b — pre-existing endpoint behaviour — but the client surface now exposes it. No mitigation needed for this phase.
- **PII handling:** The extracted `client_name`, `address`, etc. are PII. They are held in React state and sent to `saveJob` only on subsequent edits (the 5b code does not auto-persist). No logging of PII in the client. Fine.
- **XSS:** All extracted strings are rendered via React text binding (`text()` helper in `CircuitCard`) — no `dangerouslySetInnerHTML`. Safe.
- **Auth bypass on retry:** `request()` retries GET/HEAD/OPTIONS only (`api-client.ts:32-43`); POST is not retried. Good — no risk of double-charging OpenAI on a flaky network.
- **CSRF:** `credentials: 'include'` + `Authorization` header — standard bearer-token flow, not vulnerable to CSRF absent cookie-only auth fallback.

No P0/P1 security issues introduced by this commit.

---

## 5. Performance

- **Single GPT-Vision call per tap:** Unavoidable. ~2-8 s typical based on CCU latency (same model family).
- **No client-side image downscaling:** A 20 MB photo round-trips in full. The backend does not compress either. Consider `createImageBitmap` + canvas resize to ≤2048 px longest edge + JPEG re-encode at q=0.85 before POST — cuts upload time on mobile LTE ~10×. Same concern applies to 5a CCU (not unique to 5b). See `compressForTrainingLog` in `extraction.js:56-62` for the backend equivalent already used for logging.
- **`mergeCircuits` mutation safety:** `.slice()` at `:227`, `{...row}` at `:244`, good. No accidental shared references.
- **`mergeObservations` allocates an internal `keys` array of length `existingRows.length` + `added`:** O(N·M) dedupe check via `some()` where N = existing and M = incoming. For realistic ceiling (≤50 observations both sides), trivial. A `Map<"si|code", Existing>` + `Map<"loc|prefix", Existing>` would be O(N+M) but optimisation is premature.
- **`updateJob(patch)` re-render:** `applyDocumentExtractionToJob` only returns sections that changed, so JobContext re-render is minimal. Good.

No P1 perf issues.

---

## 6. Accessibility

**A11y-1. Dual error banners are both `role="alert"` and rendered simultaneously.**
`circuits/page.tsx:306-313` and `:315-322` both use `role="alert"`. If both fire (edge case — CCU and doc both fail on the same session), screen readers will announce both. Plus the visual styling is identical, so a sighted user cannot quickly tell which button failed. Recommended: prefix the message ("CCU: …" / "Extract: …") or render a single error slot.

**A11y-2. `actionHint` uses `role="status"` (polite) but "Reading document…" is a transient transition.**
This is technically correct — polite announcements are right for progress — but combined with `setActionHint` being overwritten on success, screen-reader users may miss the "Reading document…" entirely on fast networks. Acceptable.

**A11y-3. The "Extract" rail button loses its label when busy.**
`:407` changes the label to "Reading" and the icon to `Loader2`. The button element does not have `aria-busy="true"` or an `aria-label` clarifying that it's the Extract button still. Screen-reader users pressing Tab during extraction will hear "Reading button" with no connection to the feature. Add `aria-busy={docBusy}` and `aria-label="Extract document"` (same applies to the CCU rail button, pre-existing from 5a).

**A11y-4. The hidden `<input type="file">` is `className="sr-only"` + `aria-hidden` (`:278, :294`).**
`aria-hidden` on a focusable element is an accessibility anti-pattern — it hides semantics but keyboard users can still tab into it. Use `tabIndex={-1}` instead of / in addition to `aria-hidden`, or replace both with a proper visually-hidden class that keeps it focusable via the triggering button's `.click()`.

**A11y-5. File-picker trigger announcement.**
The rail button uses only the label text "Extract". Screen-reader users get no hint that activation opens a file picker. Consider `aria-haspopup="dialog"` or a descriptive `aria-label="Extract certificate data from photo"`.

**A11y-6. Loader2 spinner animation is unconditional.**
`className={...animate-spin}` (`:446`) does not respect `prefers-reduced-motion`. Global style may already handle this — not verified in this review.

No WCAG-AA blockers, several polish items.

---

## 7. Code Quality

**Strengths:**
- Excellent inline documentation; every whitelist is cross-referenced to the backend prompt line and to the iOS source file it mirrors.
- Whitelist-driven section merges (`INSTALLATION_STRING_KEYS`, `SUPPLY_KEYS`, `BOARD_KEYS`) — forward-compat with backend prompt evolution.
- Deterministic fallbacks for `crypto.randomUUID` (`:187, :261, :337`) — correct for older browsers / JSDOM tests.
- Consistent naming/style with 5a; easy to read the two modules side-by-side.

**Weaknesses:**
- **Unsafe casts:** Five `as unknown as Record<string, unknown>` casts (`:307, :347`), plus generic casts in `circuits/page.tsx:91, :93, :148, :198`. They are mechanical and defensible (the section bags are typed as `Record<string, unknown>` at the JobDetail seam) but collectively they erode type safety. The `schedule_item`/`regulation` passthrough specifically deserves a real field on `ObservationRow`.
- **Duplicated fallback-id pattern:** The `globalThis.crypto?.randomUUID?.() ?? ...` expression appears 3× in this file alone, already appears in `apply-ccu-analysis.ts` and `apply-extraction.ts`. Extract to a `newId(prefix)` helper.
- **`Circuit` type in `circuits/page.tsx`:** `Record<string, string | undefined> & { id: string }` (`:49`) is narrower than `CircuitRow` (which has `unknown` values to tolerate booleans from CCU analysis). When CCU sets `is_rcbo: true` and then Doc fills other fields, this component silently coerces. Not a bug here but type confusion.
- **`persist(circuits.map(...))`:** Inside `patchCircuit` (`:106`), this operates on the full `circuits` array, not `visible`. Correct behaviour but calling the local variable `circuits` shadows the type alias. Fine for now.
- **`mergeBoard` dead code:** see P1-2.

---

## 8. Test Coverage

**None.** There are no tests in `web/src/lib/recording/` (nor anywhere under `web/`). No vitest/jest config surfaced via `*.test.*` or `*.spec.*` globs.

This is the highest-leverage gap in the commit. The merge rules encoded here are subtle (fill-empty-only across 4 section shapes, ref-case-folding, observation dedupe with two OR'd rules, yes/no coercion) and regressions would be invisible until an inspector notices a corrupted certificate. Minimum test surface:

- `mergeInstallation` — fill-empty vs existing non-empty; yes/no coercion; `next_inspection_years` numeric parse.
- `mergeBoard` — no-existing-board synth; matched-board merge; no-incoming-fields no-op (currently buggy per P1-2).
- `mergeCircuits` — case-insensitive ref match; new-row append with `board_id`; no-clobber on filled fields.
- `mergeObservations` — both dedupe paths (schedule_item+code, location+50-char prefix); `parseObservationCode` round-trip; preservation of `schedule_item`/`regulation` metadata.
- `applyDocumentExtractionToJob` — malformed envelope (`success: false`, missing `formData`) returns empty patch.

No integration or e2e coverage exists for the UI wiring either. The file-picker reset (`event.target.value = ''`) logic at `:184` is a recurring iOS Safari gotcha worth covering.

---

## 9. Suggested Fixes (numbered, file:line)

1. **[P1]** `web/src/lib/recording/apply-document-extraction.ts` — inside `mergeCircuits` (after `:247`), coerce `polarity_confirmed` and `rcd_button_confirmed` from backend-speak (`"✓"`, `"true"`, `"false"`) to UI enum (`"pass"` / `"fail"` / `"na"`). See P1-1.
2. **[P1]** `web/src/lib/recording/apply-document-extraction.ts:205` — replace the dead reference-equality check with `if (!changed) return null;`. See P1-2.
3. **[P1]** `web/src/lib/types.ts:216-230` — add `schedule_item?: string; regulation?: string;` to `ObservationRow`, then remove the `as unknown as Record<string, unknown>` casts at `apply-document-extraction.ts:307, 347`. See P1-3.
4. **[P1]** `web/src/lib/recording/apply-document-extraction.ts:138` — replace `if (existing[key] !== undefined)` with `if (hasValue(existing[key]))` for the YESNO keys. See P1-4.
5. **[P1]** `web/src/app/job/[id]/circuits/page.tsx:182-186` — add client-side file-size guard (e.g. `if (file.size > 10 * 1024 * 1024) { setDocError('Photo is too large — please choose one under 10 MB.'); return; }`). Optionally downscale via canvas before POST. See P1-5.
6. **[P2-a11y]** `web/src/app/job/[id]/circuits/page.tsx:397-412` — add `aria-busy={ccuBusy}`/`aria-busy={docBusy}` and explicit `aria-label` props on both CCU and Extract rail buttons so busy-state icon-only labelling remains announceable. See A11y-3.
7. **[P2-a11y]** `web/src/app/job/[id]/circuits/page.tsx:315-322` — prefix the extract error with "Extract:" (and the CCU error at `:306-313` with "CCU:") so the two `role="alert"` regions are distinguishable. See A11y-1.
8. **[P2-a11y]** `web/src/app/job/[id]/circuits/page.tsx:271-295` — replace `aria-hidden` on the hidden file inputs with `tabIndex={-1}`. See A11y-4.
9. **[P2]** `web/src/lib/recording/apply-document-extraction.ts:374-421` — track section-level changes in the `summary` so the hint can say "Document read — installation + 3 circuits merged" instead of "no new data" when only installation changed. See P2-4.
10. **[P2]** `web/src/lib/recording/apply-document-extraction.ts` / `apply-ccu-analysis.ts` / `apply-extraction.ts` — extract the `globalThis.crypto?.randomUUID?.() ?? ...` triplet into a shared `newId(prefix: string)` helper.
11. **[Test]** Add `web/src/lib/recording/apply-document-extraction.test.ts` covering the merge rules enumerated in §8.
12. **[Test]** Add a minimal rendering test for `circuits/page.tsx` covering the three `handleDocFile` outcomes (success, `ApiError`, non-API `Error`).

---

## 10. Verdict + Top-3 Priorities

**Verdict:** ✅ Ship, with follow-ups. The commit delivers the feature, respects the plan, and does not regress any existing flow. The merge policy is documented, consistent with Phase 5a, and stricter than iOS in the right direction. There are no P0 issues and no security risks introduced. However, the absence of tests on a 422-LOC merge helper with subtle per-section rules is the dominant risk; and the `polarity_confirmed` coercion gap will bite the first time an inspector runs Extract on a photo that actually has that column legible.

**Top-3 priorities to address (in order):**

1. **Fix `polarity_confirmed` / `rcd_button_confirmed` coercion** (P1-1 / Fix #1). This is user-visible corruption the moment an inspector uses the feature on a cert that has those columns — cert data becomes `"✓"` in a field the UI can't show and the PDF pipeline doesn't expect.
2. **Add unit tests for `apply-document-extraction.ts`** (Fix #11). The merge contract is encoded only in code comments and the handoff memo — a single vitest file covering the 5 described cases would catch any future prompt-schema drift.
3. **Widen `ObservationRow` to include `schedule_item` / `regulation`** (P1-3 / Fix #3). Removes five unsafe casts and makes the observation dedupe path type-checked instead of structurally coupled. Cheapest high-confidence improvement in the list.
