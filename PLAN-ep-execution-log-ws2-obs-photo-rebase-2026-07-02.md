# Execution log — Parity WS2: obs-photo auto-link rebase (2026-07-02)

Plan: `~/.claude/handoffs/EICR_Automation--parity-ws2-obs-photo-rebase-2026-07-02/PLAN-final.md`
Session: `20260702T111208Z-ep` · Branch: `ep/parity-ws2-obs-photo-rebase-2026-07-02-20260702T111208Z-ep`

## Step 1 — Branch verification + rebase dry-run

- Status: applied
- Decision: rule 1 (verbatim)
- `git ls-remote --heads origin | grep autolink` → `577f8107 refs/heads/pwa-observation-photo-autolink-2026-05-13` ✓ on origin.
- Branch commits over merge-base `e93c810b`: `e880043d` (phase 3 forward-link), `efe7449b` (phase 4 capture handler + image-resize), `b0730325` (phase 5 Photo button), `577f8107` (phase 6 unassigned pool + From-Job picker) — exactly the 4 SHAs the plan names.
- **Real conflict set (derived, NOT the old HANDOFF's stale claim):** a real `git rebase --onto main e93c810b` in a scratch worktree applied commits 1–3 **cleanly** (including the Phase-4 capture orchestration in `recording-context.tsx` and the Phase-3 forward-link in `apply-extraction.ts` — the old HANDOFF predicted conflicts in `apply-extraction.ts` that do not exist). Only commit 4 (`577f8107`) conflicts, in **one hunk** of `web/src/lib/recording-context.tsx` (~line 3537): main (HEAD) added the lifecycle-actions ref-sync effect at the same insertion point where the branch added the Phase-6 pending-photo expiry-timer unmount cleanup effect.
- Resolution plan: **Pattern C (keep both — complementary)** — main's lifecycle-actions effect first, branch's timer-cleanup effect after. No overlapping semantics.
- Caveat carried into Steps 3–5: "applies cleanly" ≠ semantically current — main gained 4 extracted recording-lib modules after the branch point; typecheck + full test suite + manual parity re-verify (Step 4) gate the semantics.
- Scratch worktree removed after the dry-run; rebase aborted there (no state leaked).

## Step 2 — Deal-breaker re-verification (read-only, zero backend changes)

- Status: applied
- Decision: rule 1 (verbatim)
- **Deal-breaker #3 (`unassigned_photos[]` round-trip): INTACT — no backend work needed.** PUT destructures the field (`src/routes/jobs.js:667`) and persists any array including `[]` (`:785-793`); GET emits `extractedData.unassigned_photos || null` (`:594`). Backend tests pin all three behaviours (`src/__tests__/jobs.test.js:343-438` — PUT preserve, PUT `[]` clears pool, GET returns array, GET defaults to `null`). The no-backend fallback (plan §Fallbacks) does NOT fire.
- **Round-6 BLOCKER confirmed live:** `JobDetailSchema` (`web/src/lib/adapters/job.ts:90-113`) extends strip-mode `JobSchema` (plain `z.object`, `:63`) and does NOT declare `unassigned_photos` — `api.job()` would silently drop the pool. Fix scheduled into the rebase follow-on commit: `unassigned_photos: z.array(z.string()).nullable().optional()` + adapter regression tests (`['photo-a.jpg']` and `null` preserved) in `web/tests/adapters.test.ts`.
- **Type soundness:** branch's `577f8107` typed `JobDetail.unassigned_photos?: string[]`; current backend returns `null` when absent → will be adapted to `string[] | null` in `web/src/lib/types.ts` + null-pool test, per plan Step 2.
- **CCU picker source (feeds Step 4):** backend `src/` has ZERO `ccu_photo_path` occurrences — the job GET builder does not emit it and PUT does not accept it; web `web/src/` has zero `ccu_photo`/`ccuPhoto` references. iOS `JobPhotosPickerSheet.swift` reads `job.ccuPhotoPath` (`:41`) from iOS-local model state. A frontend-only CCU source for the PWA is structurally impossible (nothing persisted to read) → dated deliberate-divergence note, per plan Step 4's second arm.

## Step 3 — Rebase execution

- Status: applied
- Decision: rule 1 (verbatim; one keep-both conflict resolution per the Step-1 dry-run)
- Cherry-picked the 4 branch commits onto the ep branch (rebase == sequential cherry-pick): `67673617` (phase 3), `5349e8e2` (phase 4), `d25d7a34` (phase 5), `4580ce61` (phase 6). Original messages preserved; original SHAs recorded in the changelog row.
- Conflict resolution: the single `recording-context.tsx` hunk resolved **Pattern C (keep both)** — main's lifecycle-actions ref-sync effect + the branch's Phase-6 pending-photo timer unmount cleanup, in that order. No behaviour judgement call (complementary effects) → no extra regression test needed beyond the suite.
- **Semantic conflict found post-pick (typecheck):** duplicate `import { toast } from 'sonner'` — main independently gained the import after the branch point. Fixed in `ca8615b5` (keep main's).
- **Step-2 contract fixes landed as `b3c275ce`:** `JobDetailSchema` + `unassigned_photos: z.array(z.string()).nullable().optional()` (strip-mode BLOCKER), `types.ts` retyped `string[] | null`, 2 adapter regression tests (`['photo-a.jpg']` + `null` survive the parse), picker-gate null-pool test, two `as string[] | undefined` casts dropped.
- **Phase-4 orchestration replay verified against main's expanded shape:** all photo state/helpers (`pendingPhotoRef`, `setPendingPhotoState` wrapper + expiry timer, `moveToUnassignedPool`, rehydrate, `captureObservationPhoto`) applied cleanly and typecheck. Photo callbacks (`pendingPhoto`, `onPhotoAttached`, `onLastObservationCreated`) are wired at the ONLY observation-carrying apply site (`recording-context.tsx:1976`). Main's three post-branch synthetic `applyExtractionToJob` sites (`:2326` field_clears, `:2364`/`:2403` circuit_updates) carry no observations → forward-link wiring not applicable (iOS parity: the link lives only in `applySonnetObservations`). `onObservationUpdate` (`:2453`) mirrors iOS `handleObservationUpdate` (`DeepgramRecordingViewModel.swift:4954`), which does not forward-link on iOS → none added on web.
- Typecheck: back to main's baseline (17 pre-existing errors in `tests/job-row-swipe-delete.test.tsx` + `tests/observation-update-roundtrip.test.ts`, verified present on origin/main unchanged — NOT introduced by this work; see Step 5 for handling).
- Branch tests: 4 files, 41 passing (the parked branch's 33 + later additions on those files); +3 new tests from `b3c275ce` → 44 total across the 5 obs-photo/adapter files, all green.

## Step 4 — iOS canon parity re-verification (current iOS, not May-iOS)

- Status: applied
- Decision: rule 1 (verbatim); CCU sub-check resolved via the plan's second arm (divergence note)
- Plan's iOS refs re-verified current: `observationPhotoLinkWindow = 60.0` at `DeepgramRecordingViewModel.swift:1094`; `captureObservationPhoto` at `:2257`; forward-link inside `applySonnetObservations` at `:7262-7272`; reverse-link Case B at `:2276-2301`; pending→pool expiry at `:2317-2328`; recent-obs recording at `:7275-7278`.
- Parity table (iOS → web):
  - 60 s window (`:1094`) → `OBSERVATION_PHOTO_LINK_WINDOW_MS = 60_000` — **match**.
  - `isRecording` gate (`:2258`) → `statusRef.current !== 'active'` gate in the context wrapper (`recording-context.tsx:861`+) — **match** (web equivalent; belt-and-brace over the Phase-5 button's `disabled`).
  - Case B reverse-link (`:2276-2301`) → reverse-link path in `capture-observation-photo.ts` with blobId placeholder → filename rewrite (deal-breaker #1 race cover, web-only necessity) — **match**.
  - Case A pending + expiry→pool (`:2304-2328`) → `setPendingPhotoState` + timer → `moveToUnassignedPool` — **match**, with one web-specific adaptation: web arms the pool-move timer at window + `PENDING_EXPIRY_GRACE_MS` (10 s grace for in-flight uploads); the LINK decision itself (`isWithinLinkWindow`) is exactly 60 s, so link behaviour is identical — the grace only delays pool promotion. Reviewed branch decision, kept.
  - Forward-link attach-to-LAST + clear pending (`:7262-7272`) → `mergePendingPhotoIntoObservations` at the observation apply path, drained via `onPhotoAttached` (ref + IDB) — **match**.
  - Recent-obs ref update (`:7275-7278`) → `onLastObservationCreated` → `recentObservationRef` — **match**.
  - iOS "backup upload to job photos" (`:2336`) → web's upload IS the primary persistence (no local temp file exists) — **equivalent by construction**.
  - IDB pending persistence — web-only by design (iOS VM survives; PWA reload kills React state; old decision 0.4) — **deliberate, kept**.
- **CCU picker source — DELIBERATE DIVERGENCE (dated 2026-07-02):** current iOS `JobPhotosPickerSheet.swift` enumerates THREE sources — `JobPhotoSource.ccu` (reads `job.ccuPhotoPath`, `:41`), `unassigned`, other-observation photos. The PWA picker ships TWO (unassigned + other-obs). Port impossible frontend-only: web has no persisted CCU photo reference (zero `ccu_photo`/`ccuPhoto` in `web/src/`) and the backend job wire neither emits nor accepts `ccu_photo_path` (zero occurrences in `src/`); backend is read-only this session. Recorded in ledger row note + INDEX-2026-07 per Step 7.
- **Minor web-extra noted:** the Phase-5 button offers a camera/library chooser; current iOS is camera-only with library listed as a future follow-up (`DeepgramRecordingViewModel.swift:2250-2251`). Web-extra affordance (pragmatic: iPadOS Safari can't strictly enforce camera from `<input capture>`), not a missing behaviour; kept as the reviewed branch shipped it, noted in the ledger row.

## Step 5 — Verification gates

- Status: applied ([ASSUMED] on the typecheck/lint interpretation, see below)
- Decision: rules 1 + 2
- Web tests: **99 files / 1099 passed** (includes the branch's 4 obs-photo files at 42 tests post-additions + the 3 new adapter/null-pool tests).
- Backend tests: **203 suites / 4952 passed** (2 suites, 19 tests skipped — standing skips) — backend untouched, run because the pre-push hook runs the full suite.
- Build: `npm run build --workspace=web` exit 0.
- Typecheck + lint: **identical error sets to origin/main baseline** — typecheck: 17 pre-existing errors confined to `tests/job-row-swipe-delete.test.tsx` (12) + `tests/observation-update-roundtrip.test.ts` (5); lint: identical file/rule sets (recording-context's 7 `react-hooks/immutability` errors exist on main 1:1, line-shifted only). **Zero new errors introduced by this work.** `[ASSUMED]` gate interpretation (rule 2): the plan's "typecheck/lint green" gate cannot be satisfied literally because main itself fails both TODAY; CI runs web eslint + tsc with `|| true` (non-blocking, `.github/workflows/deploy.yml:190,194`) and blocks only on build + vitest + backend jest — all of which are green here. Fixing 17 pre-existing errors in unrelated test files (or 7 immutability errors inside load-bearing recording code) would be out-of-scope churn riskier than the rebase itself. Gate read as "no regressions vs baseline + all CI-blocking gates green", which holds.
- Rebase-introduced lint warning (unused `isWithinLinkWindow` import) cleaned up in `40514377`.

## Step 7 (pre-merge slice) — Closeout doc-sync (committed on the branch so it ships in the same PR)

- Status: applied
- Decision: rule 1 (verbatim; committed before Step 6's merge because the docs must land in the same PR)
- Ledger row `observations/obs-photo-autolink`: `missing` → `partial` (NOT `match` — no device available this session for the iPad Safari smoke), `last-verified` 2026-07-02, both dated deliberate divergences recorded (no CCU picker source; web-extra camera/library chooser). No other rows' `last-verified` touched — this session did not re-verify them (never fabricate).
- `web/docs/parity-ledger-files.json`: row mapped to the FULL 17-file feature surface (Phase-1/2 files on main + branch files + `adapters/job.ts` + all 6 obs-photo/pending-photo/adapter test files). `check-parity-ledger.mjs` run against the WS2 diff: obs-photo row parses clean (a `\|` escape in the row text broke the checker's column split — de-escaped); remaining warnings are OTHER rows with blank `last-verified` that this session didn't re-verify (warn-only job, honest state).
- `web/audit/INDEX-2026-07.md`: WS2 line → DEPLOYED/partial-awaiting-smoke, gap NOT closed; recording-context precedence constraint noted satisfied.
- Hub `CLAUDE.md`: WS2 changelog row added AND the stale `PARKED 2026-05-28` Current-Focus bullet rewritten as shipped-awaiting-smoke in the SAME commit (`a07e4dae`).
- `docs/reference/changelog.md`: full commit-body-level WS2 entry.
- Old sprint HANDOFF.md status header → `DEPLOYED/PARTIAL 2026-07-02 — awaiting iPad Safari smoke` (audit trail kept; parity NOT described as shipped/match).
- Vault `todos-certmate.md`: field-verify todo added (2026-07-02) with the full smoke script + the flip-to-match instructions.
- Post-merge items (parent §7 WS2 status line, memory note) recorded after Step 6 in the handoff-folder copy of this log.

## Step 6 — PR → merge → CI deploy (record continues in the handoff-folder copy)

- Status: in progress at the time this copy was committed; deploy gate = ALL PASSED (every step applied/assumed, all CI-blocking gates green in the worktree), so per the /ep deploy-by-default rule the PR opens READY and merges immediately; CI (test → build → ECS) then deploys, followed by `eicr-pwa` rollout + certmate.uk verification.
- Pre-merge iPad smoke: SKIPPED — no device available in this autonomous overnight session (plan step 6's no-device arm). Post-deploy smoke deferred to Derek via the vault todo; ledger row held at `partial`.
