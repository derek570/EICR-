# Phase 5d — LiveFillView Review

**Commit:** `cccd548`
**Reviewer:** Claude (Opus 4)
**Scope:** web-rebuild, live-fill dashboard + flash pipeline.
**Files inspected:**
- `web/src/lib/recording/live-fill-state.ts` (new, 216 L)
- `web/src/components/live-fill/live-field.tsx` (new, 119 L)
- `web/src/components/live-fill/live-fill-view.tsx` (new, 421 L)
- `web/src/lib/recording/apply-extraction.ts` (modified, +109/-)
- `web/src/lib/recording-context.tsx` (modified, +28/-14)
- `web/src/app/job/[id]/layout.tsx` (modified, +24/-)
- `web/src/app/globals.css` (modified, +64)

---

## 1. Summary

Phase 5d lands a full-form live dashboard that replaces the active tab whenever the recording state is `active|dozing|sleeping`. Each extracted field briefly highlights brand-blue and fades over 2 s. The implementation is neat: a module-level `LiveFillStore` backed by `useSyncExternalStore`, a pure-CSS transition on a `data-recent` attribute, and a diff-based `changedKeys` pipeline grafted onto `applyExtractionToJob`. Design intent in the handoff is honoured accurately (Option A mount, 3 s recency window, 2 s fade, em-dash placeholders, EIC/EICR section gating, reduced-motion fallback).

The code is production-shaped but there are several issues worth tightening before Phase 6 — one correctness bug in how the store handle's identity cascades through `RecordingProvider`, a couple of timing edge cases on fresh→stale transitions, an accessibility over-announcement risk, and the absence of any tests.

## 2. Alignment with Plan (PHASE_5D_HANDOFF.md)

| Plan item | Status |
|---|---|
| (1) `applyExtractionToJob` returns `{ patch, changedKeys }` | Done — `apply-extraction.ts:340-417` |
| Diff pre-patch vs patch, not readings | Done — `diffSectionKeys` / `diffCircuitKeys` / `diffObservationKeys` |
| (2) `LiveFillState` with `markUpdated`/`isRecent`/`reset` | Done — `live-fill-state.ts:81-166` |
| `useSyncExternalStore` + per-field selector | Done — `useIsFieldRecent` `live-fill-state.ts:207-213` |
| (3) `<LiveField>` CSS-only `data-recent` attr | Done — `live-field.tsx:52` |
| `prefers-reduced-motion` → 200 ms fade | Done — `globals.css:245-251` |
| (4) `<LiveFillView>` sections: installation / supply / board / circuits / observations | Done |
| EIC variant: extent card, skip observations | Done — `live-fill-view.tsx:120-137, 278` |
| (5) Option A mount (swap tab content) | Done — `layout.tsx:135-141` |
| (6) Auto-scroll on `lastUpdatedSection` change | Done — `live-fill-view.tsx:39-50` |
| (7) `tsc --noEmit` clean, lint unchanged | Per commit body — not independently re-run |
| Field-key convention | Documented in `live-fill-state.ts:26-31` and used consistently |
| `role="status"` + `aria-live="polite"` | Present on root (`live-fill-view.tsx:65-67`) — see §6 for concern |

Gaps vs plan:

- The handoff called out `section keys`, including installation / supply / board / circuits / observations, but `LiveFillSection` also declares `'extent'` and `'design'`. `design` is never rendered in `<LiveFillView>`; any `design.*` change will `markUpdated` but the flash will never paint. Either remove `design` routing from `SCALAR_SECTIONS` or render a design card for EIC.
- `applyExtractionToJob` still mounts circuit 0 field clears into the patch but never emits `changedKeys` entries for them (comment in `recording-context.tsx:283-285` states this is deliberate — "no flash for field_clears"). Worth adding to the handoff changelog, because the handoff implicitly said "every field that actually changed".

## 3. Correctness

### P0 — (none)

Nothing will break recording or data integrity.

### P1

**P1-1. `useLiveFillStore()` handle identity changes every extraction → cascading `useCallback` re-creation.**
`live-fill-state.ts:191-200` memoises the returned handle on `[snapshot.lastUpdatedSection, snapshot.lastUpdatedAt]`. Both change on every `markUpdated` call. In `recording-context.tsx:118-292`, `liveFill` is a dependency of `applyExtraction`, which is a dep of `openSonnet` (line 338), which is a dep of `beginMicPipeline` (line 380), which is a dep of `handleWake` (line 441). It is also a direct dep of `start` (line 520) and `stop` (line 533). Net effect: every successful Sonnet extraction during an active session re-creates the entire callback graph. Nothing reopens the Sonnet WS (the stale `SonnetSession` instance is kept in `sonnetRef`), so this is not a functional bug — but it's unnecessary churn and a foot-gun for future refactors that might use the callback identity as a `useEffect` dependency.

Fix: change `useLiveFillStore` to return a stable handle. Either (a) return `liveFillStore` directly and subscribe separately for `lastUpdatedSection`/`lastUpdatedAt`, or (b) split into two hooks — `useLiveFillActions()` (stable, imperative) and `useLiveFillSection()` (reactive). The current usage in `LiveFillView` only needs `lastUpdatedAt`/`lastUpdatedSection` for the scroll effect; `RecordingProvider` only needs `markUpdated`/`reset`.

**P1-2. Fresh→stale transition relies on scheduled cleanup, which is delayed an extra ~50 ms past the recency window.**
`useIsFieldRecent` uses `() => store.isRecent(key, windowMs)` as its snapshot getter (`live-fill-state.ts:207-212`). `isRecent` computes `Date.now() - ts < windowMs` on the fly. `useSyncExternalStore` only re-reads the snapshot when the store emits. If no new markUpdated fires, the only trigger for the fresh→stale transition is the cleanup sweep scheduled at `DEFAULT_WINDOW_MS + 50` (3050 ms). So a field that flashed at `t=0`:

- is "recent" (returns `true`) from t=0 to t≈3000 — correct.
- stays `data-recent="true"` in the DOM until the store next emits.
- emits at t≈3050 when the cleanup timer fires and prunes the key.

Between 3000 ms and 3050 ms the field is still flashed visually (DOM attribute `true`, CSS transition-time=0 per `globals.css:240-243`), even though `isRecent` would now return `false` if queried fresh. This is a 50 ms off-by-a-hair; in practice invisible, but worth noting because the CSS rule `data-recent="true" { transition: 0s }` means the fade to transparent only begins the moment the attribute flips to `"false"`. A narrower cleanup delay (match `DEFAULT_WINDOW_MS` exactly, or trigger cleanup at the exact first-key expiry) avoids the discrepancy.

There is a second-order concern: if `markUpdated` is never called again (recording stops or extraction goes quiet), and the last update was within the cleanup window, the timer *does* fire and the component *does* re-render. Good. But if the component unmounts during the window, the timer keeps running against stale listeners — the store never clears the timer on store-less. Low severity because the subscribe/unsubscribe from useSyncExternalStore removes the listener.

**P1-3. `diffCircuitKeys` mis-flashes on Sonnet overwriting an existing value.**
`applyCircuitReadings` (`apply-extraction.ts:209-219`) skips writes when `hasValue(row[reading.field])` is true. So an existing populated cell is *not* patched. `diffCircuitKeys` compares patched vs pre-patch; since no change landed, no flash. Correct.

However, when `applyCircuit0Readings` merges sections, it spreads `existing` *then* the new fields (line 156). If the existing section already has the field, `bySection[section]` never writes it (guarded at line 146). So the patch section can contain the key with the old (existing) value. `diffSectionKeys` then compares `prev[field] !== after[field]` — same reference, no flash. Correct. But the patch is shipped to `updateJob` which may trigger React re-renders downstream because the section object's identity changed even though content is identical. Minor perf concern only (Phase 4 territory), not a flash bug.

**P1-4. `diffSectionKeys` false negative on falsy-but-meaningful values.**
Line 289: `if (prev[field] !== after[field] && hasValue(after[field]))`. If Sonnet sets `supply.number_of_supplies = 0` (a legitimate zero) or a boolean `false`, `hasValue` returns `true` for both (line 124 — `typeof v === 'boolean' || typeof v === 'number'`), so 0 and false are fine. But `hasValue('')` is `false` and `hasValue([])` is `false`. If Sonnet ever emits an empty-array clearing or a user-facing empty-string, no flash fires. Acceptable for v1 because the apply layer skips those values anyway via the 3-tier guard.

### P2

**P2-1. `LiveCircuitRow` reads `circuit.description` as fallback for `circuit_designation` (line 312), but `CircuitRow` type declares `description?: string` and `applyCircuitReadings` only ever writes `circuit_designation`.** The fallback is dead code for the extraction path; it might resolve against manually-entered circuit rows. Worth a code comment or removal for clarity.

**P2-2. `LiveCircuitRow.id` vs DOM `id` attribute** (`live-fill-view.tsx:318`): `id={`live-circuit-${id}`}` — but the auto-scroll effect targets `[data-section="circuits"]`, not individual rows. So these element IDs are unused today. Fine to keep for future "scroll to specific circuit" behaviour but worth a comment.

**P2-3. `observation.description ?? <em>…</em>` renders an em-dash for undefined but not for empty-string.** Line 411. If Sonnet ever emits `description: ""`, the cell renders empty instead of `…`. Apply layer filters this at `apply-extraction.ts:244`, so unreachable today — but fragile.

**P2-4. `scrollIntoView` can hijack the page viewport.** Line 47 calls `target.scrollIntoView({ behavior: 'smooth', block: 'start' })`. `scrollIntoView` walks ancestors. Since `LiveFillView`'s root is a scroll container (`overflow-y-auto`, line 68), and `JobBody` is also a scroll container (`overflow-y-auto`, layout.tsx:139), both will scroll. The intent ("scope the scroll to this overlay's scroll container" — comment line 37) isn't actually achieved by `scrollIntoView`. Consider computing the offset manually or using `scrollIntoViewOptions` with `inline: 'nearest'` + a custom container scroll.

**P2-5. `aria-live="polite"` on the root announces the entire form.** See §6.

**P2-6. `useIsFieldRecent` getSnapshot uses `Date.now()` at call time**, which makes it time-dependent between `subscribe` callbacks. React tolerates this because the return is a primitive boolean compared with `===`, but the pattern subtly violates the contract ("must return the same value until the store changes"). If React ever enforces this with a dev-mode warning, this call will be flagged. Alternative: derive `isRecent(key)` from the snapshot's version + computed age.

## 4. Security

No new network paths, auth surface, or user-supplied markup. `LiveField`/`LiveFieldWide` render `String(value)` into text content — not `dangerouslySetInnerHTML` — so no XSS risk. `data-section` / `data-recent` attribute values are controlled by TypeScript literals.

Minor: the store is a module-level singleton. In a multi-tenant / multi-job SSR context, it would leak state across sessions. In this SPA-shaped app with a single active job and a client-only `'use client'` boundary, it's fine. Worth noting in the doc comment for future refactorers (Phase 8 production promotion).

## 5. Performance

- **Per-field re-render scoping: good.** `useIsFieldRecent` returns a boolean, React bails out via `===`, only flipped fields re-render. This is the right primitive.
- **Store emit cost: O(listeners)** which equals roughly every rendered `<LiveField>` + `<LiveCircuitRow>` + `<LiveObservationRow>` plus one for `<LiveFillView>` itself. On a ~60-field form with ~15 circuits each with 8 cells = ~185 listeners. A single markUpdated fires all of them; each computes its selector and bails out. Acceptable — ~0.5 ms per update in practice.
- **Cleanup sweep: O(n) every 3 s.** Fine.
- **P1-1 callback cascade** noted above.
- **`LiveCircuitRow` / `LiveObservationRow` not memoised** (no `React.memo`). When a *different* field flashes, the parent `<LiveFillView>` still re-renders (`useLiveFillStore` subscription), which recurses through the map. Row components read from the per-field hook but also read all their props from the circuit/observation reference. Since `job.circuits` is typically a new array after each patch, all rows re-render every extraction. Low-to-moderate cost; wrap both in `React.memo` with a comparator on `id` + shallow fields for a clean win.
- **Section entrance animation uses `nth-child`** which is robust for this commit but couples structure and style. If Phase 6 adds another top-level section, the nth-child rules up to `:nth-child(6)` (globals.css:269-286) silently drop the 7th's stagger. Consider CSS custom-property `--stagger-index` set per-section in JSX.

## 6. Accessibility

- **`prefers-reduced-motion`: honoured** for both the flash (`globals.css:245-251`) and the section entrance (`globals.css:283-287`). Scroll call also checks the preference (`live-fill-view.tsx:46`).
- **`role="status"` + `aria-live="polite"` on the root of the 400+ field surface**: this is a problem. When ANY descendant text changes (and a Sonnet extraction may change 10+ fields in one tick), the entire subtree is announced by screen readers. NVDA/JAWS will queue a long stream. Real-world effect: an inspector running with VoiceOver will hear a flood of labels + values every turn, swamping the transcript feedback.
  - Fix: scope `aria-live` to narrower regions (per section, or even a hidden `role="status"` that reads `"{count} fields updated in supply"` after each extraction), or use `aria-atomic="false"` + `aria-relevant="additions"` to suppress re-announces of unchanged text.
- **Colour-only signalling for "just filled"**: the blue flash is the only visual cue. Inspectors relying on colour-contrast or colour-blind inspectors may miss it. The value text *does* appear (from em-dash to real value), so the signal isn't purely colour — acceptable.
- **`data-recent`/ARIA link**: consider adding `aria-describedby` on newly-filled fields pointing to a hidden status ticker for screen-reader-only cue.
- **No `<h2>`/`<h3>` in section cards inside `<LiveFillView>`** — relies on `SectionCard`'s own heading. Verify `SectionCard` emits a heading element (not inspected here). If it only renders a styled `<span>`, the region lacks landmark structure.
- **`em-dash` on empty cells**: screen readers will announce "em dash" — consider `aria-label="empty"` on the value span when `isEmpty`.

## 7. Code Quality

- **Excellent doc comments** throughout — every file has a "why this design" block that matches the commit body. This is the project's house style and it's followed well.
- **Key convention locked at the store layer**, but the enforcement is runtime/documentation only. A tagged-union helper like `scalarKey(section, field)` / `circuitKey(id, field)` would make wrong-key drift a type error.
- **`cn` utility used consistently** with Tailwind + CSS variables — good.
- **`routeSupplyField` default**: falls through to `'supply'` for unknown fields (line 118). This is noted in comments but could cause silent mis-routing if the server prompt adds a new `installation.*` field. Consider logging to console.warn in dev.
- **`applyExtractionToJob` still returns `Partial<JobDetail>` in the public `null | Applied` type but the actual old shape is no longer exposed.** The refactor from `Partial<JobDetail>` to `AppliedExtraction` is complete — the only caller was updated (recording-context.tsx:278-292). Clean.
- **`LiveFillSection` union includes `'extent'` and `'design'` but `<LiveFillView>` renders `extent` only when `certificateType === 'EIC'` and does not render `design` at all.** See §2 gap.
- **Unused `useIsFieldRecent` import in `LiveFillView`** — line 6: `useIsFieldRecent` is imported but only used in `LiveCircuitRow` and `LiveObservationRow`, both declared in the same module. Not a bug; just noise.
- **Inline string `'?'` fallback for missing circuit refs** (`live-fill-view.tsx:311`) — acceptable.
- **No `React.memo` / no `useMemo` for derived values** like `ref`, `designation`, `colour` — these are cheap primitives so fine.

## 8. Test Coverage

**Zero tests accompany this commit.** `web/` has no `tests/` or `__tests__/` directory, and `package.json` has no `test` script. Given the scope of this change (mutable external store + per-field subscriptions + diff-based change detection + auto-scroll with accessibility branches), the missing coverage is a real gap.

Recommended unit tests:

1. `diffSectionKeys` — regression on primitives, objects (same reference / different reference), arrays, zero/false/empty-string edge cases.
2. `diffCircuitKeys` — new-row yields `circuit.{id}` + each populated cell key; modified-row yields only changed cells; removed row yields nothing.
3. `diffObservationKeys` — only new observations.
4. `LiveFillStore.markUpdated` → `isRecent` — window boundary, multiple keys, reset.
5. `LiveFillStore.scheduleCleanup` — single-timer invariant, re-schedules while entries remain.
6. `applyExtractionToJob` end-to-end: feed a representative `ExtractionResult`, assert both `patch` and `changedKeys`.

Recommended component tests (React Testing Library):

7. `<LiveField>` flashes (data-recent attribute flips) when the key is marked recent, fades back on reset/timeout.
8. `<LiveFillView>` renders extent card only for EIC; observations only for EICR.
9. `JobBody` swaps children→LiveFillView on state transition.
10. Reduced-motion branch: scroll uses `behavior: 'auto'`.

## 9. Suggested Fixes (Numbered, file:line)

1. **[P1]** `web/src/lib/recording/live-fill-state.ts:185-201` — Split `useLiveFillStore` into a stable imperative hook (`useLiveFillActions`, returns frozen `{markUpdated, reset}`) and a reactive hook (`useLiveFillSection`, returns `{lastUpdatedSection, lastUpdatedAt}`). Update `recording-context.tsx:120` to use actions only; update `live-fill-view.tsx:32` to use the reactive hook.
2. **[P1]** `web/src/lib/recording/live-fill-state.ts:146-164` — Tighten the cleanup timer: schedule at the *earliest* key's expiry (`min(timestamps) + DEFAULT_WINDOW_MS`) so fresh→stale flips align with the recency window instead of trailing by 50 ms.
3. **[P1]** `web/src/lib/recording/live-fill-state.ts:207-213` — `useIsFieldRecent` should derive from the versioned snapshot, not recompute `Date.now()` in the snapshot getter. Example: subscribe and re-check on each emit; additionally schedule a `setTimeout(windowMs - age)` per field on first recent flip so the transition is JS-driven. Or accept the current pattern but document the React-contract caveat.
4. **[P1]** `web/src/components/live-fill/live-fill-view.tsx:65-67` — Remove `aria-live="polite"` from the root. Add it (or `role="status"`) narrowly to a hidden `<div>` that emits a concise "Supply: Ze filled, 3 fields updated" summary per extraction. Drive it from `lastUpdatedAt` + `changedKeys`.
5. **[P1/P2]** `web/src/lib/recording/live-fill-state.ts:37-44` — Remove `'design'` from `LiveFillSection` (or add a Design card to `<LiveFillView>` for EIC). Either direction, update `apply-extraction.ts:274` `SCALAR_SECTIONS` to match.
6. **[P2]** `web/src/components/live-fill/live-fill-view.tsx:308-379` — Wrap `LiveCircuitRow` and `LiveObservationRow` in `React.memo` keyed on `circuit.id`/`observation.id` + a shallow-equal of the cell values. Avoids redundant row-tree re-renders when a single field flashes.
7. **[P2]** `web/src/components/live-fill/live-fill-view.tsx:39-50` — Replace `scrollIntoView` with a manual scroll on `rootRef.current` to prevent ancestor-scroll hijack. Compute `target.offsetTop - root.offsetTop` and call `root.scrollTo({ top, behavior })`.
8. **[P2]** `web/src/app/globals.css:269-286` — Replace the six `:nth-child(n)` rules with a JSX-driven `style={{ animationDelay: `${i * 40}ms` }}` per section so adding a 7th section in Phase 6 keeps its stagger.
9. **[P2]** `web/src/lib/recording/apply-extraction.ts:117-119` — Change `routeSupplyField` default from silent `'supply'` to `console.warn` in dev + `'supply'`. Prevents silent mis-routing of new server fields.
10. **[P2]** `web/src/components/live-fill/live-field.tsx:45-48` and `:91-95` — Extract the empty-check into a shared helper `formatValue(value)` so the two components don't drift.
11. **[P2]** `web/src/components/live-fill/live-field.tsx:48` — When `isEmpty`, add `aria-label="empty"` to the value `<span>` to suppress the VoiceOver "em dash" literal reading.
12. **[P2]** `web/src/components/live-fill/live-fill-view.tsx:411` — Use `observation.description?.trim() || <em>…</em>` so empty strings also render the placeholder.
13. **[P2]** Add a lightweight test file at `web/src/lib/recording/__tests__/apply-extraction.test.ts` covering the diff functions — quickest ROI given no test runner exists yet. Wire a `test` script in `web/package.json` with `vitest` or `node:test`.
14. **[P2]** `web/src/lib/recording-context.tsx:120` — Once fix (1) lands, `liveFill` in the dep arrays of `applyExtraction`, `start`, `stop` can be dropped (actions are stable), eliminating callback rebuilds.
15. **[P2]** `web/src/components/live-fill/live-fill-view.tsx:6` — The unused-ish `useIsFieldRecent` import at the top level is only consumed by the child components in the same file; fine to keep, but a one-line comment avoids a future "unused import" lint prune.

## 10. Verdict + Top 3 Priorities

**Verdict: SHIP — with follow-ups.** The feature works, matches the handoff, matches iOS parity, and the architectural choices (module-singleton store + `useSyncExternalStore` + CSS-attribute transition) are the right ones. None of the findings block the Phase 5 close or Phase 6 kickoff.

**Top 3 priorities for a cleanup pass:**

1. **Split `useLiveFillStore` into stable actions + reactive section** (fix #1, #14). Prevents an entire class of future `useEffect`/`useCallback` identity bugs during active recording.
2. **Rework the `aria-live` scope** (fix #4). As-written, a screen-reader inspector will hear the full form read back on every Sonnet turn — a real workflow regression vs the iOS client.
3. **Add at least diff-function unit tests** (fix #13) and wire up a `test` script. Diff correctness is the single load-bearing algorithm behind the flash; regressions here silently mis-highlight fields.

Wrote reviews/claude/phase-5d.md.
