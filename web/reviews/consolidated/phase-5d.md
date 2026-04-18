# Phase 5d — LiveFillView Consolidated Review

**Commit:** `cccd548` — feat(web): Phase 5d LiveFillView
**Reviewers consolidated:** Claude (Opus 4), Codex
**Verifier:** Opus 4

---

## 1. Phase Summary

Phase 5d ports iOS `LiveFillView` to the web. While recording is `active`/`dozing`/`sleeping`, the active tab body is replaced (Option A mount) with a full-form dashboard that flashes brand-blue on each Sonnet-populated field and fades to transparent over ~2 s.

Architecture:
- `applyExtractionToJob` refactored to return `{ patch, changedKeys }`, computing the change list by **diffing** pre-patch vs post-patch job state (robust against extractor prompt drift).
- `LiveFillStore` — module-level singleton backed by `useSyncExternalStore`; per-field `useIsFieldRecent(key)` selector keeps re-renders leaf-scoped.
- `<LiveField>` / `<LiveFieldWide>` — CSS-only `data-recent` attribute + 2 s ease-out transition; `prefers-reduced-motion` shortens to 200 ms.
- Key convention: `section.field`, `circuit.{id}.field`, `circuit.{id}`, `observation.{id}`.
- Sections rendered: installation, supply, board, circuits, observations (EICR only), extent (EIC only). **No design card.**
- Auto-scroll: `useEffect` watches `lastUpdatedSection` + `lastUpdatedAt` and calls `scrollIntoView` on `[data-section="…"]` within `rootRef`.
- Files: `web/src/lib/recording/live-fill-state.ts` (new, 216 L), `web/src/components/live-fill/live-field.tsx` (new, 119 L), `web/src/components/live-fill/live-fill-view.tsx` (new, 421 L), plus diffs into `apply-extraction.ts`, `recording-context.tsx`, `app/job/[id]/layout.tsx`, `app/globals.css`.

Both reviewers land on **Ship with follow-ups**; the mechanism is sound, but there are shared concerns around provider subscription churn, accessibility over-broadcast, the missing Design section, and zero test coverage.

---

## 2. Agreed Findings

| # | Severity | Area | Location | Finding |
|---|----------|------|----------|---------|
| A1 | P1 | Correctness / Parity | `web/src/components/live-fill/live-fill-view.tsx:62` + `web/src/lib/recording/live-fill-state.ts:37-44`, `apply-extraction.ts:274` | **Design section is emitted into `LiveFillStore` (`LiveFillSection` union includes `'design'`, `sectionOfKey` routes `design.*`, `SCALAR_SECTIONS` includes it) but `<LiveFillView>` never renders a `data-section="design"` card.** Any `design.*` field flash is invisible and auto-scroll is a no-op. Claude tags this as a gap vs plan (P1/P2); Codex tags it P1. **Adjudicated: P1** — the store emits change keys that have no visible target, which breaks the "full form" contract. |
| A2 | P1 | Performance / Architecture | `web/src/lib/recording/live-fill-state.ts:185-201`; `web/src/lib/recording-context.tsx:118` (and deps at `:278, 338, 380, 441, 520, 533` per Claude / `:278, 475, 523, 609` per Codex) | **`useLiveFillStore()` in `RecordingProvider` subscribes to snapshot changes**, so `markUpdated` mutates `lastUpdatedSection`/`lastUpdatedAt` → `useMemo` returns a new handle → `applyExtraction`/`start`/`stop` `useCallback`s are re-created every extraction, cascading into `openSonnet`/`beginMicPipeline`/`handleWake` and forcing `useRecording()` consumers to re-render. Not a functional bug today, but undercuts the "leaf-only re-render" story and is a footgun for future `useEffect` deps. **Fix:** split into a stable imperative hook (`useLiveFillActions`) and a reactive hook (`useLiveFillSection`), or expose `liveFillStore` methods directly to the provider without subscribing. |
| A3 | P1/P2 | Accessibility | `web/src/components/live-fill/live-fill-view.tsx:62-68` | **`role="status" aria-live="polite"` applied to the root of a 400+-field subtree.** A single Sonnet turn may mutate 10+ fields; NVDA/JAWS/VoiceOver will queue a flood of label+value announcements, swamping the inspector's feedback. Replace with a narrow hidden announcer emitting concise summaries (e.g. "Supply: 3 fields updated"). Claude tags P1, Codex tags P2. **Adjudicated: P1** — real-world regression vs iOS for accessibility users. |
| A4 | P2 | Test Coverage | No tests added; `web/` has no `test` script | **Zero unit/component tests** for `diffSectionKeys` / `diffCircuitKeys` / `diffObservationKeys`, `LiveFillStore.markUpdated`/`isRecent`/cleanup, or `<LiveFillView>` section gating. The diff functions are load-bearing — silent regressions there will silently mis-highlight fields. Both reviewers recommend at least diff-function tests plus wiring a `test` script (vitest or node:test). |
| A5 | P2 | Accessibility | `web/src/app/globals.css:240-251`; `web/src/components/live-fill/live-field.tsx:50` | **Flash signal is colour-only.** Reduced-motion is handled, but no secondary cue (icon, text, border) for low-colour-discrimination users. Em-dash → value transition is a partial signal. Consider a hidden status ticker or an outline cue. |

---

## 3. Disagreements + Adjudication

| Topic | Claude position | Codex position | Adjudication |
|-------|----------------|----------------|--------------|
| Severity of Design-section omission | P1/P2 gap vs plan (§2 + fix #5) | P1 correctness bug (§3) | **P1** — it's a direct correctness/parity miss: the store publishes `design` updates that nothing renders. Keep at P1. |
| Severity of `aria-live` on full surface | P1 (§6 + fix #4) | P2 (§6) | **P1** — a screen-reader user hearing the full form re-read every Sonnet turn is a workflow regression, not just polish. |
| Scope of "missing board/install fields" | Not raised | P2 — board card omits `designation`, `location`, `phases`, `ze`, `zs_at_db`, `ipf_at_db` that appear on the board tab (§3) | **Accept at P2, with caveat.** Codex is correct that `<LiveFillView>` board card does not mirror the full board tab. However, note that the live view's supply card *does* include `zs_at_db` (line 179), and the board tab has evolved post-5d to `board.boards[]` (Codex §7 drift note). Treat as a parity-debt follow-up, not a bug introduced by this commit. Keep P2. |
| `RecordingProvider` churn — P1 or P2? | P1 (§3 P1-1) | P2 (§5) | **P1** — Claude's trace through the full callback graph (`applyExtraction` → `openSonnet` → `beginMicPipeline` → `handleWake`) is concrete and matches the shipped source. Codex's description is shorter but consistent. Align on P1 because the cascade is broad and the fix is cheap. |

---

## 4. Claude-Unique Findings

| # | Severity | Location | Finding |
|---|----------|----------|---------|
| C1 | P1 | `web/src/lib/recording/live-fill-state.ts:146-164` | **Cleanup timer trails the recency window by 50 ms.** `setTimeout(cleanup, DEFAULT_WINDOW_MS + 50)`; between t=3000 and t≈3050 a field is visually still flashed but `isRecent` would return `false` if re-queried. CSS rule `data-recent="true" { transition: 0s }` means the fade only begins at attribute flip. Schedule at `min(timestamps) + DEFAULT_WINDOW_MS` to align. |
| C2 | P1 | `web/src/lib/recording/live-fill-state.ts:207-213` | **`useIsFieldRecent`'s `getSnapshot` calls `Date.now()` on every invocation**, technically violating `useSyncExternalStore`'s "must return same value until store changes" contract. Works today because the return is a primitive compared with `===`, but would trip a future dev-mode warning. |
| C3 | P2 | `web/src/lib/recording/apply-extraction.ts:289` | `diffSectionKeys` guard `hasValue(after[field])` rejects empty string/array as "no change". Unreachable today because apply layer filters upstream, but fragile. |
| C4 | P2 | `web/src/components/live-fill/live-fill-view.tsx:39-50` | **`scrollIntoView` walks ancestors and can hijack `JobBody` / page scroll** because both are `overflow-y-auto` containers. Replace with manual `root.scrollTo({ top: target.offsetTop - root.offsetTop, behavior })`. |
| C5 | P2 | `web/src/app/globals.css:269-286` | **Section entrance stagger via `:nth-child(1..6)`** silently drops stagger on a 7th section. Move to JSX-driven `style={{ animationDelay: …ms }}`. |
| C6 | P2 | `web/src/lib/recording/apply-extraction.ts:117-119` | `routeSupplyField` silently defaults unknown fields to `'supply'`. Add a dev-only `console.warn` to catch prompt drift. |
| C7 | P2 | `web/src/components/live-fill/live-fill-view.tsx:308-379` | **`LiveCircuitRow`/`LiveObservationRow` not memoised.** Parent `<LiveFillView>` re-renders on every `markUpdated`; since `job.circuits` is a fresh array per patch, all rows re-render. Wrap in `React.memo` with shallow comparator. |
| C8 | P2 | `web/src/components/live-fill/live-field.tsx` | Suggests extracting shared `formatValue()` helper since `LiveField`/`LiveFieldWide` duplicate empty-check logic. |
| C9 | P2 | `web/src/components/live-fill/live-field.tsx:48` | Add `aria-label="empty"` on value span when `isEmpty` to suppress VoiceOver literal "em dash" reading. |
| C10 | P2 | `web/src/components/live-fill/live-fill-view.tsx:411` | `observation.description ?? <em>…</em>` — use `?.trim() ||` so empty strings also render placeholder. |
| C11 | Info | `web/src/components/live-fill/live-fill-view.tsx:312` | `circuit.description` fallback for `circuit_designation` — dead code for extraction path (apply layer only writes `circuit_designation`); fine but comment for clarity. |
| C12 | Info | `web/src/components/live-fill/live-fill-view.tsx:318` | `id="live-circuit-{id}"` element IDs are unused today; auto-scroll only targets `[data-section="circuits"]`. |
| C13 | Info | `web/src/lib/recording/live-fill-state.ts:171` | Module-level singleton is fine in this SPA but would leak across sessions in SSR/multi-tenant — worth doc comment for Phase 8 promotion. |

## 5. Codex-Unique Findings

| # | Severity | Location | Finding |
|---|----------|----------|---------|
| X1 | P2 | `web/src/components/live-fill/live-fill-view.tsx:206`; `web/src/app/job/[id]/board/page.tsx:20, 31, 172, 185` | **Board card incomplete relative to board tab.** Missing `designation`, `location`, `phases`, `ze`, `zs_at_db`, `ipf_at_db` as surfaced on the main board page. (Note: some overlap with supply card — `supply.zs_at_db` is present on supply at line 179; still, the plan asked for these at the board level.) |
| X2 | P2 | `web/src/components/job/job-tab-nav.tsx:28, 50`; `live-fill-view.tsx:119` | **Post-5d convention drift:** tab nav now exposes Extent + Design for both cert types, but `LiveFillView` still hides Extent for EICR and never renders Design. Not caused by 5d, but makes the gap more visible. |
| X3 | P2 | `web/src/app/job/[id]/board/page.tsx:31`; `live-fill-view.tsx:54` | **Data-shape mismatch:** board tab centres on `board.boards[]`, but `LiveFillView` still reads flat `job.board.*` fields. Parity-debt. |
| X4 | Info | `web/src/components/live-fill/live-field.tsx:27, 80` | Notes `LiveField`/`LiveFieldWide` duplication (matches Claude C8). |

---

## 6. Dropped / Downgraded

| # | Origin | Call | Reason |
|---|--------|------|--------|
| D1 | Claude §3 P1-3 (mis-flash on Sonnet overwrite) | **Dropped as a bug**, keep the analysis as a correctness note. | Claude's own analysis concludes the 3-tier `hasValue` guard in `applyCircuit0Readings` prevents any mis-flash. No action needed. |
| D2 | Claude §3 P1-4 (falsy-but-meaningful values) | **Downgrade to informational.** | `hasValue` accepts `0` and `false`; only empty string/array are filtered, and the apply layer already filters those. Acceptable for v1. |
| D3 | Claude §3 P1-2 second-order (timer against unmounted listeners) | **Dropped.** | Claude acknowledges `useSyncExternalStore` removes the listener on unmount; no actual leak. |
| D4 | Codex §7 (`LiveField`/`LiveFieldWide` duplication) | **Keep but downgrade to Info.** | Duplication exists but both paths are trivial and well-commented; low drift risk today. Fold into C8 as one improvement. |
| D5 | Claude fix #15 (unused-looking `useIsFieldRecent` import) | **Dropped.** | It is consumed by sibling components in the same file; not actually unused. |

---

## 7. Net Verdict + Top 3 Priorities

**Verdict: SHIP with follow-ups.**
The mechanism (diff-based change list + module-singleton store + CSS-attribute transition) is architecturally right and matches iOS parity on the happy path. None of the findings block Phase 5 close or Phase 6. However, three items should land in a cleanup pass before Phase 6 solidifies:

**Top 3 Priorities**

1. **Render the Design section (or remove it from the store routing).** `LiveFillSection` includes `'design'`, `apply-extraction.ts` routes `design.*`, and `lastUpdatedSection` can become `'design'` — yet `<LiveFillView>` has no `data-section="design"` card. Pick one direction: add a Design card (`design.departures_from_bs7671`, `design.departure_details`, `design.design_comments`) for EIC (and for EICR if applicable per Codex X2), or prune `'design'` from `LiveFillSection` / `SCALAR_SECTIONS`. (Agreed A1.)

2. **Decouple `RecordingProvider` from the live-fill snapshot.** Split `useLiveFillStore()` into a stable `useLiveFillActions()` (imperative — `markUpdated`, `reset`) used by `RecordingProvider`, and a reactive `useLiveFillSection()` (exposes `lastUpdatedSection`, `lastUpdatedAt`) used only by `<LiveFillView>`. Drops `liveFill` from the `applyExtraction`/`start`/`stop` dep arrays and restores the intended leaf-only re-render story. (Agreed A2.)

3. **Replace the full-surface `aria-live` with a focused announcer.** Remove `role="status" aria-live="polite"` from the `LiveFillView` root; add a hidden concise announcer that reads e.g. "Supply: Ze, PFC, earthing updated" per extraction batch, driven by `lastUpdatedAt` + `changedKeys`. (Agreed A3.)

Stretch: add diff-function unit tests (Agreed A4) and wire a `test` script — quickest-ROI safety net for the load-bearing diff path before Phase 6.
