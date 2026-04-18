## 1. Summary of the phase
Phase 3c replaces the remaining stub tabs with real UI for Extent, Design, Inspection, Staff, PDF, and Observations, and adds a large `inspection-schedule` constants module for the EICR/EIC schedules. The implementation gets most of the visual structure in place, but several of the new tabs are still disconnected from the repo’s actual data contracts, so “editable end-to-end” is not true yet.

## 2. Alignment with original plan
The phase matches the handoff on broad UI scope: Extent, Design, Inspection, PDF, and the schedule constants are all present and broadly shaped as described. The main misses are:
- `staff/page.tsx` does not actually source staff from the existing settings API, so the role pickers are empty in real usage.
- In commit `88e7c4e`, `observations/page.tsx:86-94` still had a disabled Add button and no edit/collapse flow, which does not meet the “full iOS-parity forms” framing. The working tree has since evolved and now wires add/edit/photo flow there, so that specific gap is commit-only.
- The new data shapes for inspection/staff/extent do not align with the shared/backend contracts, so the UI intent and persistence intent diverge.

## 3. Correctness issues
- `P0`: None found.
- `P1` `web/src/app/job/[id]/staff/page.tsx:71-72,105-153` — the page reads `job.inspectors`, but `JobDetail` does not define that field (`web/src/lib/types.ts:192-207`) and `GET /api/job` does not return it (`src/routes/jobs.js:575-592`). Result: the staff tab is effectively unusable and will always render the empty state unless some external code mutates a frontend-only field.
- `P1` `web/src/app/job/[id]/inspection/page.tsx:42-52,79-111` — the new inspection model is incompatible with the shared/backend model. This page stores `items: Record<ref, outcome>` plus `is_tt_earthing`/`has_microgeneration`/`mark_section_7_na`, but the shared contract expects `inspection_schedule.items[ref] = { outcome: ... }` with camelCase flags (`packages/shared-types/src/job.ts:81-91`), and the backend only persists `inspection_schedule` (`src/routes/jobs.js:653-740`). Once save wiring lands, this data will not round-trip cleanly.
- `P1` `web/src/app/job/[id]/extent/page.tsx:28-33` — `consumer_unit_upgrade` is introduced as a valid `installation_type`, but the shared type only allows `new_installation | addition | alteration` (`packages/shared-types/src/job.ts:93-97`), and the EIC PDF renderer only knows those three (`python/eic_pdf_generator.py:370-380`). That new value will not render correctly downstream.
- `P1` `web/src/app/job/[id]/pdf/page.tsx:35-42,140-142` — readiness checks look for boards at `job.board.boards`, but the backend/shared shape exposes `boards` at the top level (`src/routes/jobs.js:583-591`, `packages/shared-types/src/job.ts:24-32`). Real jobs can therefore show a false “No boards added” warning.
- `P2` `web/src/app/job/[id]/design/page.tsx:29-33`, `extent/page.tsx:40-44`, `inspection/page.tsx:72-80` — all three pages build nested patches from stale closure state (`{ ...data, ...next }` / `{ ...insp, ...next }`) before calling `updateJob`. Because `updateJob` only shallow-merges the root object (`web/src/lib/job-context.tsx:55-58`), same-tick/concurrent writes to the same section can overwrite each other.
- `P2` In commit `88e7c4e`, `web/src/app/job/[id]/observations/page.tsx:86-94,107-113` shipped a disabled Add button and a remove-only list. That was materially short of a usable observations form. HEAD has since added `ObservationSheet`, so this is no longer true in the working tree.

## 4. Security issues
- No phase-specific security findings. I did not see any new `dangerouslySetInnerHTML`, auth bypass, CSRF, secret leakage, or injection surface introduced in these files.

## 5. Performance issues
- `web/src/app/job/[id]/inspection/page.tsx:183-247,301-364` — every chip tap rerenders the full EICR schedule (roughly 90 rows / 700+ buttons). `ScheduleRow` is not memoized and all handlers are recreated, so this will be noticeable on mobile Safari.
- `web/src/app/job/[id]/pdf/page.tsx:49-52` — `useMemo` is effectively defeated because `data` is the whole `job` object; every job update recomputes warnings even when unrelated fields change. Minor, but avoidable.

## 6. Accessibility issues
- `web/src/app/job/[id]/inspection/page.tsx:269-286` — the custom switch buttons have `role="switch"` and `aria-checked`, but no accessible name. The visible text is adjacent, not programmatically associated, so screen readers will announce an unlabeled switch.
- In commit `88e7c4e`, the observations empty state told users to “Tap Add” while the Add button was disabled (`observations/page.tsx:86-94,100-105`). That was a poor keyboard/screen-reader experience, though it has been fixed later in HEAD.

## 7. Code quality
- `web/src/app/job/[id]/staff/page.tsx:71,75` and `web/src/app/job/[id]/pdf/page.tsx:47` rely on `as unknown as ...` casts to hide schema drift instead of fixing `JobDetail`.
- `web/src/app/job/[id]/staff/page.tsx:302-306` uses a `Record<string, unknown>` cast just to force a `style` prop through an icon component. That is a code smell and makes the prop surface harder to reason about.
- `web/src/app/job/[id]/inspection/page.tsx:54-64` defines 8 section icons/accents for a 7-section schedule; harmless, but it suggests the constants were not tightened after implementation.

## 8. Test coverage gaps
- No tests for inspection schedule serialization against `InspectionSchedule`.
- No tests for PDF readiness warnings, especially the board/staff checks.
- No tests covering EIC `installation_type` values and PDF output.
- No tests for staff-tab population from saved inspector profiles/settings.
- No regression test for observations usability at the commit state versus later working-tree changes.

## 9. Suggested fixes
1. `web/src/app/job/[id]/staff/page.tsx:71-72` — stop reading `job.inspectors`; fetch inspector profiles from the existing settings API (`web/src/lib/api-client.ts:292-309`) and map `InspectorProfile` into the UI shape. This makes the tab actually usable.
2. `web/src/lib/types.ts:192-207`, `staff/page.tsx:71,75`, `pdf/page.tsx:47` — extend `JobDetail` with the staff IDs you actually use, or move them into a typed nested bag. Remove the `unknown` casts so future schema drift becomes compile-time visible.
3. `web/src/app/job/[id]/inspection/page.tsx:42-52,79-111` — change the local state shape to match `packages/shared-types/src/job.ts:81-91` (`items[ref] = { outcome }`, shared flag names), or add an explicit mapper at the save boundary. Right now the UI model and persistence model disagree.
4. `web/src/app/job/[id]/extent/page.tsx:28-33` — either remove `consumer_unit_upgrade` or update shared types and the PDF generator to support it. Leaving it frontend-only will create invalid persisted data.
5. `web/src/app/job/[id]/pdf/page.tsx:140-142` — read boards from the real top-level `job.boards` shape, or normalize backend payloads before they enter `JobProvider`. This fixes false “No boards added” warnings.
6. `web/src/app/job/[id]/inspection/page.tsx:269-286` — add `aria-label`/`aria-labelledby` to each switch, or wrap the label text and switch in a single labeled control. Unnamed switches are not acceptable.
7. `web/src/app/job/[id]/inspection/page.tsx:301-364` — memoize `ScheduleRow` and stabilize per-row handlers. This will cut unnecessary rerenders on the largest page in the phase.
8. `web/src/app/job/[id]/design/page.tsx:29-33`, `extent/page.tsx:40-44`, `inspection/page.tsx:72-80` — replace closure-based nested merges with functional updates based on latest state. Otherwise concurrent writes will continue to clobber each other.
9. `88e7c4e:web/src/app/job/[id]/observations/page.tsx:86-94` — if reviewing the commit strictly, wire Add/edit before claiming iOS parity. HEAD has already moved in this direction; keep that later fix.

## 10. Overall verdict
**Needs rework.**

Top 3 priority fixes:
1. Make the staff tab read real inspector profiles instead of nonexistent `job.inspectors`.
2. Align the inspection tab’s data model with the shared/backend `inspection_schedule` contract.
3. Remove or fully support `consumer_unit_upgrade`, and fix PDF readiness to read boards from the actual payload shape.