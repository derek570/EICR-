# Phase 5c — Consolidated Review (Observation Photos)

**Commit:** `6a73517` (`feat(web): Phase 5c observation photos`)
**Scope:** `web/src/app/job/[id]/observations/page.tsx`, `web/src/components/observations/{observation-photo.tsx,observation-sheet.tsx}`, `web/src/lib/api-client.ts`, `web/src/lib/types.ts`, CLAUDE.md.
**Reviewers consolidated:** Claude Opus 4, Codex.

---

## 1. Phase summary

Phase 5c wires real observation-photo capture into the web rebuild to achieve iOS parity. New `ObservationPhoto` component performs an auth'd blob fetch (bearer header, `URL.createObjectURL`, revoked on unmount). A new `ObservationSheet` modal provides edit UX with separate Camera (`capture="environment"`) and Library buttons, per-photo delete, and a thumbnail grid. Three new API methods (`uploadObservationPhoto`, `deleteObservationPhoto`, `fetchPhotoBlob`) are added to `api-client.ts`. `ObservationRow.photo_keys` renamed to `photos` to match the iOS model. Observations list renders up to 3 inline thumbnails + "+N" chip per card. Backend already supported the endpoints; zero backend changes.

Both reviewers agree the scaffolding is clean and architecturally sound. The dominant defect is state-ownership asymmetry: S3 writes are eager but the observation's `photos[]` is only propagated on Save, which produces lost-update / dangling-filename paths on Cancel and a save-during-upload race.

---

## 2. Agreed findings

| Severity | Area | File:line | Finding |
|---|---|---|---|
| P0/P1 (Claude P0, Codex P1) | Correctness / Data integrity | `observation-sheet.tsx:107-152`, `observations/page.tsx:70-78` | Cancel-after-upload/delete desynchronises observation state vs backend. Upload+Cancel leaves S3 orphan the observation never sees; Delete+Cancel leaves the observation referencing a filename already hard-deleted server-side → permanently broken thumbnail. |
| P1 | Performance / Correctness | `observation-photo.tsx:46-75`, `observations/page.tsx:302`, `observation-sheet.tsx:367` | No cache or in-flight dedup across thumbnails. Card preview + sheet grid each mount their own fetch for the same photo; N photos = N fetches. Acceptable for small N, poor scaling. |
| P1 | Accessibility | `observation-sheet.tsx` modal body | Modal has no focus trap, no initial focus placement, no focus restoration on close. Tab leaks to the page behind; keyboard users lose context. |
| P1 | Testing | Entire phase | No unit, integration, or E2E tests added for `ObservationSheet`, `ObservationPhoto`, blob-URL lifecycle, or upload/delete/cancel/save sequencing. |
| P2 | Security | `api-client.ts` photo/signature/logo blob helpers | No critical findings. Auth'd fetch, `encodeURIComponent` on filename, server-generated filenames, no DOM sinks. Combining `credentials: 'include'` with bearer is defence-in-depth but broadens CSRF surface (GET-only, safe by convention). |

---

## 3. Disagreements + adjudication

### 3.1 Severity of the Cancel-desync bug
- **Claude:** P0 ("real data-loss path").
- **Codex:** P1 ("silently desynchronise").
- **Adjudication:** **P0.** Claude's analysis is more complete — it separates the two distinct failure modes (orphan-add vs dangling-delete) and notes that Delete+Cancel causes a *permanent* broken thumbnail in the persisted observation. That is genuine user-visible data corruption, not merely drift. Both reviewers agree on the same fix direction (lift photo state to page, persist eagerly).

### 3.2 Save-during-upload race
- **Codex:** Flags explicitly as a P1 — `Save` is not disabled while `uploading` is true, so the persisted row can omit the in-flight photo.
- **Claude:** Does not flag directly; addresses uploads via the `disabled={uploading}` on the Camera/Library buttons but misses that the Save button at `observation-sheet.tsx:399` has no such guard.
- **Adjudication:** **Codex is correct — accept as P1.** Verified at `observation-sheet.tsx:399` that Save has no `disabled` gate on `uploading`. This is a real race independent of the Cancel bug and should be adopted in the consolidated set.

### 3.3 Invalid nested interactive controls
- **Codex:** P1 accessibility defect — clickable `div[role="button"]` containing a real `<button>` for Remove.
- **Claude:** P2-ish — acknowledges the nesting but describes it as "the usual workaround" because nesting a real `<button>` inside a `<button>` is invalid HTML, and offers no remediation.
- **Adjudication:** **P1, per Codex.** Verified at `observations/page.tsx:234-280`: outer `div[role="button"]` wrapping an inner `<button>` with `stopPropagation`. This is invalid ARIA/HTML nesting (interactive-in-interactive), produces brittle SR output, and has a clean fix (flatten to a non-interactive card with an explicit "Edit" button, or use a link wrapper + sibling remove button). Claude's "usual workaround" framing understates the defect.

### 3.4 Filename-collision race on concurrent uploads
- **Claude:** P1-flagged (`photo_${Date.now()}${ext}` could collide on ms-fast uploads).
- **Codex:** Not flagged.
- **Adjudication:** **Retain as P2, backend-side.** Real but fringe; mitigated today by `disabled={uploading}` on the picker buttons. Out of scope for Phase 5c commit; file as a backend follow-up.

---

## 4. Claude-unique findings

| ID | Severity | File:line | Finding |
|---|---|---|---|
| C1 | P1 | `observation-sheet.tsx:107-132` | No client-side file-size / MIME validation. A 50MB HEIC uploads, succeeds, produces a bad thumbnail; `.svg`/`.tiff` sneak past `accept="image/*"` and produce a bland 400. |
| C2 | P1 | `observation-sheet.tsx:134-152`, trash `:374-382` | Delete photo fires an immediate irreversible backend DELETE with no confirmation. UX parity with iOS calls for a confirm step. |
| C3 | P1 | `observation-sheet.tsx:378` | Trash button touch target is 24×24 (`h-6 w-6`), below the 44×44 mobile minimum (project design-system rule). |
| C4 | P1 | `observations/page.tsx:96-101` | `editing` not memoised; `observations.find` runs every render, produces fresh reference, will churn future memoisation. |
| C5 | P2 | `observations/page.tsx:53`, `observation-sheet.tsx:80` | `useMemo(() => getUser()?.id, [])` with empty deps — signed-out→signed-in transition in the same tree won't refresh. Consistent with rest of app; low risk. |
| C6 | P2 | Backend | `photo_${Date.now()}${ext}` filename collision on concurrent fast uploads; suggests UUID generation server-side. |
| C7 | P2 | `observation-sheet.tsx:190` | Sheet title heuristic keys on `observation.description` — renders "Add observation" when editing a row that has no description. Should key on new/existing. |
| C8 | P2 | `observations/page.tsx:58` | Stale comment referencing unused `'new'` sentinel. |
| C9 | P2 | `observation-sheet.tsx:371` | Generic `alt="Observation defect photo"`; could inject description when present. |
| C10 | P2 | `api-client.ts:247/348/421` | `fetchPhotoBlob` / `fetchSignatureBlob` / `fetchLogoBlob` are near-duplicates; collapse to a single `fetchAuthedBlob(path)` helper. |
| C11 | P2 | `observations/page.tsx:24`, `observation-sheet.tsx:53` | `CODE_COLOUR` / `CODE_LABEL` duplicated; extract to shared module. No central `const OBSERVATION_CODES` for `'C1' | 'C2' | 'C3' | 'FI'`. |
| C12 | P2 | `observation-sheet.tsx` `animate-pulse` skeleton | `prefers-reduced-motion` not honoured. |
| C13 | P2 | Latent | Blob fetch buffers full bytes; safe today (thumbnails only) but a future full-res lightbox needs aggressive `revokeObjectURL`. |

---

## 5. Codex-unique findings

| ID | Severity | File:line | Finding |
|---|---|---|---|
| X1 | P1 | `observation-sheet.tsx:399` | Save button has no `disabled={uploading}` guard; save-during-upload race produces a persisted observation missing the in-flight photo. (Adjudicated into Agreed set; kept here for traceability of origin.) |
| X2 | Observational | Working-tree drift | Confirms `observations/page.tsx`, `observation-sheet.tsx`, `observation-photo.tsx` are unchanged since `6a73517`; `api-client.ts` and `types.ts` have later Phase 6 additions but 5c methods/types are untouched — so review lines still resolve. |

---

## 6. Dropped / downgraded

| Finding | Origin | Action | Rationale |
|---|---|---|---|
| Suggested fix #8 (non-optimistic delete state mutation) | Claude §9.8 | **Dropped** | Claude itself self-corrected: the code `await`s before mutating; not a real issue. |
| `makeId()` uses `Math.random()` not crypto | Claude §3 P2 | **Downgraded to informational** | Non-security use (client-local observation id only); collision negligible for a single session. |
| `credentials: 'include'` on auth'd blob GETs | Claude §4 | **Downgraded to informational** | GETs are safe-by-convention; cookies layered with bearer is defence-in-depth, not a finding. |
| `handleFile` reuse across both inputs taking `files?.[0]` | Claude §3 P1 | **Downgraded to informational** | Neither input has `multiple`; correct by design. |
| Re-fetch on grid render (ObservationPhoto) | Claude §5 | **Merged into Agreed row #2** | Same underlying observation as Codex's no-cache finding. |

---

## 7. Net verdict + top 3

**Net verdict: Approve with changes (Phase 5c.1 follow-up required).**

Both reviewers converge on the same critique: the commit ships a well-structured, iOS-parity photo flow whose one architectural flaw — draft-local photo state over eager backend side effects — produces multiple real defects (Cancel desync, Save-during-upload race) that inspectors will hit in normal use. Accessibility polish and the nested-interactive card are the next tier of must-fix. Nothing security-critical; no deploy blockers; fixes can land as a Phase 5c.1 patch before Phase 5d builds on this surface.

**Top 3 priorities:**

1. **Lift photo state to the page and persist eagerly** (`observation-sheet.tsx:119/140`, `observations/page.tsx:80`). Drop photos-only Save/Cancel gating; on successful upload/delete call `updateJob({ observations })` immediately, matching iOS's eager-commit semantic. Closes both Cancel-desync variants.
2. **Guard Save against in-flight uploads** (`observation-sheet.tsx:399`). Either `disabled={uploading}` on Save/Cancel or await outstanding upload promises before close. Closes the save-during-upload race.
3. **Accessibility pass on sheet + card** — flatten the nested interactive controls on the observation card (`observations/page.tsx:234-280`), enlarge the trash touch target to ≥44×44 (`observation-sheet.tsx:378`), add modal focus management (initial focus, focus trap, restore on close), and add a delete confirmation. All cheap, all aligned with project design-system rules.

Tests for the Cancel/Save/upload sequencing and `ObservationPhoto` blob-URL lifecycle should land alongside these fixes before Phase 5d introduces concurrent UI over the same data.
