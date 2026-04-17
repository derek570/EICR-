# Phase 5d — LiveFillView (handoff)

> Web rebuild · branch `web-rebuild` · prerequisite sub-phases 5a–5c all shipped (latest: `6a73517`)

## Objective

Port iOS `LiveFillView` to the web so that during an active recording
session the inspector sees every captured field populate in real time,
with a brief brand-blue highlight on each newly-filled field. Mirrors
iOS parity so the two clients behave the same when listening.

## iOS reference

| Concern | File · line |
|---|---|
| View composition | `CertMateUnified/Sources/Views/Recording/LiveFillView.swift` (1539 lines) |
| State container | `CertMateUnified/Sources/ViewModels/LiveFillState.swift` |
| Flash mechanic | `LiveFillView.swift:804-856` (`LiveField` view) |
| Auto-scroll | `LiveFillView.swift:101-108` (`onChange(of: lastUpdatedSection)`) |
| Mount site | `CertMateUnified/Sources/Views/JobDetail/JobDetailView.swift:280` (inside tab 0 when `isRecording || isPaused`) |
| Marking fields | `DeepgramRecordingViewModel.swift:2124, 3271, 3290` → `markFieldUpdated` + `markRegexUpdate` |

### Key mechanics to copy

1. **Per-field flash** — each `LiveField` reads `state.isFieldRecent(key)`
   (true if the field was marked updated within the last 3s). When true,
   the background rounds to `brandBlue @ 0.15` with `animation(.easeOut(duration: 2.0))`.
   No keyframes — a single Bool-toggle drives the fade-out.
2. **Auto-scroll to updated section** — `ScrollViewReader` watches
   `lastUpdatedSection` and animates `proxy.scrollTo(section, anchor: .top)`
   on change. Only active when `isRecording` is true.
3. **Section entry animation** — `cmSectionEntrance(index: n, appeared:)`
   staggers the initial render so the view doesn't flash all sections at
   once. Web can use a simple `animation-delay` per section.
4. **Full form shown, not just changed fields** — iOS renders the whole
   form (installation → supply → board → circuits → observations). The
   flash just highlights what's new. Don't be tempted to render only
   changed fields — inspectors rely on the static layout for spatial
   memory.

### What iOS does that we can skip

- **Typing animation** (`TypingText` at `LiveFillView.swift:829`) — nice
  but optional. A plain value render + background flash conveys the
  same signal. Defer unless inspectors ask for it.
- **Landscape-specific compact layout** — iOS has two code paths. Web
  can collapse to a single responsive layout using CSS grid + media
  queries.
- **CCU slot correction grid** (`slotCrops`) — driven by an iOS-only
  geometric extractor Phase that hasn't been ported. Leave out.
- **Observation typing reveal** — same as above; a fade-in is enough.

## Web state already in place (reuse, don't rebuild)

| Concern | Location |
|---|---|
| Recording session + Sonnet WS | `web/src/lib/recording-context.tsx` (665 lines) |
| Extraction → JobDetail patch | `web/src/lib/recording/apply-extraction.ts:276` (`applyExtractionToJob`) |
| 3-tier priority guard | `web/src/lib/recording/apply-extraction.ts:122` (`hasValue`) |
| Job state provider | `web/src/lib/job-context.tsx` (exposes `useJobContext`) |
| Recording provider | `web/src/lib/recording-context.tsx` (exposes `useRecording`) |
| Mount site candidate | `web/src/app/job/[id]/layout.tsx:75-83` (already renders `RecordingOverlay` + `TranscriptBar`) |
| Transcript overlay pattern | `web/src/components/recording/recording-overlay.tsx` |

Important: `applyExtractionToJob` currently returns `Partial<JobDetail>
| null`. It does **not** return a list of which fields changed. Phase
5d needs that list — see step 1 below.

## Implementation plan

### 1. Extend extraction output with a change list

In `web/src/lib/recording/apply-extraction.ts`:

- Refactor `applyExtractionToJob` to return
  `{ patch: Partial<JobDetail>; changedKeys: string[] } | null`.
- `changedKeys` is a flat list of dot-path field identifiers
  (`installation.client_name`, `supply.ze`, `circuit.{id}.zs`,
  `observation.{id}`), one entry per field the patch will actually
  change vs the pre-patch job state.
- Update the single caller (`recording-context.tsx:276-281`
  `applyExtraction`) to pass `changedKeys` into the new LiveFillState
  store.

**Trade-off to decide:** compute `changedKeys` by diffing before/after,
or by inspecting the readings array. Diffing is simpler and robust
against prompt drift. Do diffing.

### 2. Create `LiveFillState` (web version)

New file: `web/src/lib/recording/live-fill-state.ts`. Mirror the iOS
container but trimmed:

```ts
type LiveFillState = {
  recentlyUpdated: Map<string, number>; // key → timestamp
  lastUpdatedSection: 'installation' | 'supply' | 'board' | 'circuits' | 'observations' | null;
  markUpdated(keys: string[]): void;
  isRecent(key: string, windowMs?: number): boolean; // default 3000
  reset(): void;
};
```

Store the map in a React context so `<LiveFillView>` + any embedded
field components read from the same source. A simple `useSyncExternalStore`
pattern works well here — mutations need to trigger re-renders but not
cascade through the whole tree.

### 3. Create `<LiveField>` primitive

New file: `web/src/components/live-fill/live-field.tsx`. Takes
`{ label, value, fieldKey }` and wraps the value in a `<span>` whose
background transitions from `var(--color-brand-blue) / 0.15` → transparent
over 2 seconds when `isRecent(fieldKey)` flips true.

Implementation: CSS-only. Use a `data-recent="true|false"` attribute and
a CSS `transition: background-color 2s ease-out`. Toggling the attribute
in React re-triggers the transition automatically.

Handle `prefers-reduced-motion` — drop the animation to a 200ms fade so
the signal is still visible.

### 4. Create `<LiveFillView>`

New file: `web/src/components/live-fill/live-fill-view.tsx`.
Layout sections in iOS order. Each section has an `id` attribute so
the auto-scroll effect (`lastUpdatedSection` → `scrollIntoView`) can
target it.

Sections (EICR):

1. Installation — client name, address, postcode, premises, records
   available, evidence of additions/alterations.
2. Supply — earthing arrangement, Ze, PFC, voltage (U / Uo), frequency,
   live conductors, number of supplies, SPD fields.
3. Board — manufacturer, location, phases, designation, Ze, Zs at DB,
   IPF at DB.
4. Circuits — grid row per circuit: ref, designation, OCPD summary,
   RCD summary, Zs, IR, R1+R2. Each circuit ref gets its own id
   (`circuit-{id}`) so a newly-filled circuit scrolls into view.
5. Observations — list by code + text preview. EIC skips this.

EIC variant: skip observations, include extent-covered card.

### 5. Mount LiveFillView

In `web/src/app/job/[id]/layout.tsx`, add a conditional render: when
`recordingState === 'active'` (or `'dozing'`/`'sleeping'`), render
`<LiveFillView>` as an overlay on top of the current tab's content
(like iOS does inside tab 0). Two placement options:

- **Option A (iOS-parity):** swap tab content for `<LiveFillView>` when
  recording, restore on stop. Matches iOS exactly.
- **Option B (less invasive):** render as a fixed-position fullscreen
  overlay above the tab content; the FloatingActionBar stays visible at
  the bottom.

Recommendation: **Option A** — matches iOS, no new z-index juggling,
and the transcript bar stays where it already is.

### 6. Wire up auto-scroll

Inside `<LiveFillView>`, watch `lastUpdatedSection` in a `useEffect`.
When it changes, call `document.getElementById(section)?.scrollIntoView({ behavior: 'smooth', block: 'start' })`.
Skip if `prefers-reduced-motion` is set.

### 7. Verify

```bash
cd web
npx tsc --noEmit
npm run lint
```

Baseline: 0 errors, 6 pre-existing warnings (unrelated files). Don't
regress either.

**Manual test plan:**
- Open a fresh EICR job, hit Record.
- Speak "Ze is point three eight ohms, PFC 1.2 kilo amps, TN-S earthing."
- Verify: Supply section visible, Ze / PFC / earthing flash blue,
  fade out after ~2s, auto-scroll happens if off-screen.
- Speak "Circuit 3, zs 0.47, IR infinite."
- Verify: circuits section scrolls into view, row for circuit 3
  flashes, IR + Zs cells flash blue.
- Stop recording — LiveFillView should disappear, the normal tab
  content returns.

Commit: `feat(web): Phase 5d LiveFillView` with a body per
`CLAUDE.md` commit rules and a new row in the Changelog.

## Design decisions to nail in the plan

1. **Option A vs B mount** — recommendation Option A; confirm with Derek
   before writing code (small chance he prefers overlay so he can peek
   at the tab underneath).
2. **Field-key naming convention** — use `section.field` for scalar
   sections (`supply.ze`), `circuit.{id}.field` for circuit cells,
   `observation.{id}` for whole-observation adds. Lock this down first
   so every producer uses the same keys.
3. **Highlight window** — iOS uses 3s for the "recent" check plus a 2s
   CSS fade-out. Keep those values.
4. **Accessibility** — `role="status"` + `aria-live="polite"` on the
   section containers so screen readers announce new data. Respect
   `prefers-reduced-motion` throughout.

## Scope exclusions (for the commit message)

- Typing animation per character (iOS `TypingText`).
- CCU slot-correction grid (iOS `slotCrops`).
- Landscape-specific compact layout.
- Per-observation fade-in animation (plain list is fine for v1).

## After 5d

Phase 5 closes. Next phases from the memory memo:

- **Phase 6** — Admin + Settings parity (inspector profiles, signature
  upload, org settings).
- **Phase 7** — PWA manifest + offline + accessibility pass.
- **Phase 8** — Staged deploy + production promotion (promote
  `web-rebuild` → `main`, update `docker/frontend.Dockerfile` to point
  at new `web/`, verify CI/CD pipeline).

## Useful references

- Latest shipped commit: `6a73517` (Phase 5c observation photos)
- CLAUDE.md changelog: top few rows for 5a/5b/5c — follow the same
  level of detail for the 5d entry.
- Project memory: `.claude/projects/-Users-derekbeckley-Developer-EICR-Automation/memory/project_web_rebuild_phase5.md`
