# iOS ↔ PWA Parity Backlog

Rollup of gaps surfaced by the eight-phase parity audit (Wave A, 2026-04-24). Each line links to a phase report; detailed gap bodies live there.

Audit methodology & prompt templates: `~/.claude/plans/we-ve-just-finished-a-enumerated-hellman.md`.
Guiding rule: **iOS is canon. Divergence is a bug unless explicitly documented** (`~/.claude/projects/-Users-derekbeckley-Developer-EICR-Automation/memory/feedback_ios_is_canon_for_parity.md`).

## Wave B — fix progress (branch `pwa-parity-fixes`, worktree at `../EICR_Automation_parity`)

| # | Domain | Status | Commit(s) |
|---|--------|--------|-----------|
| B0 | Branch + env setup | ✅ done | `61d7d76` (audit docs on branch) |
| B1 | Data-shape P0s — bucket rename | ✅ done | `2314566`, `28556f9` (codex fixes) |
| B1.1 | Outcome enum + schedule-flag canonicalisation | ✅ done | `7e88133`, `5cc2022` (codex revert) |
| B2 | Tab / nav structural P0s (Observations tab, Extent/Design EIC-only) | ✅ done | `86dac39` |
| B3a | PDF tab bucket cleanup (was already wired on main) | ✅ done | `f8ab898` |
| B3b | Change Password page | ✅ already on main — no work needed |
| B3c | Defaults area | ✅ already on main (incl. cable defaults) — no work needed |
| B3d | CCU three-mode + review sheet | ✅ already on main — no work needed |
| B6.1 | Dashboard recent-jobs cap + Defaults tile | ✅ done | `181fc3a`, `39cb5a1` (codex fix) |
| B5.1 | Staff tab — InspectorProfile shape + roster fetch | ✅ done | `317d18d`, `780266a` (codex fix) |
| B2.1 | T&Cs acceptance gate (Phase 2 P0 #1) | ✅ done | `06caaf9`, `6465a4a` (codex fix) |
| B2.4 | Dashboard JobRow swipe-delete regression test | ✅ done — feature already on main from `9fcbeed`; this commit only adds the missing test coverage flagged by the audit (Phase 2 P0 #4 was a false-positive from stage6) |
| B4 | Deepgram + Recording config | ⏳ open — needs main-vs-stage6 cross-check first |
| B5 | Recording UI parity | ⏳ open — needs main-vs-stage6 cross-check first |
| B6 | Remaining dashboard + settings P0s (T&Cs gate, preset picker on creation, swipe delete on rows, admin form drift) | ⏳ open |
| B7 | Inner-field drift (CircuitRow, ObservationRow, per-bucket field naming) | ⏳ open — biggest remaining work |
| B8 | Cert-gated tabs + Staff remaining (3-way InspectorProfile shape, Phase 4 carry-forwards) | ⏳ open |
| B9 | P1 sweeps | ⏳ open |
| B10 | P2 hygiene + final handoff | ⏳ open |

### Full Wave B commit log

| SHA | Subject |
|-----|---------|
| `6465a4a` | close T&Cs gate open-redirect + preserve query string (codex fix on `06caaf9`) |
| `06caaf9` | T&Cs acceptance gate — /terms page + AppShell client-side redirect |
| `780266a` | clear Staff-tab roster on user-change / fetch-failure (codex fix on `317d18d`) |
| `317d18d` | consolidate Staff tab to canonical InspectorProfile + wire roster fetch |
| `39cb5a1` | dashboard recent-jobs initial cap (codex fix on `181fc3a`) |
| `181fc3a` | dashboard recent-jobs cap + Defaults tile |
| `5cc2022` | revert flag-key camelCase rename — iOS wire is snake_case (codex fix on `7e88133`) |
| `7e88133` | canonicalise inspection-schedule outcome enum + flag casing |
| `6c50872` | INDEX progress + observations from the run |
| `f8ab898` | PDF-tab bucket names + warning logic to canonical shape |
| `86dac39` | cert-type-gate job tabs to match iOS canonical ordering |
| `28556f9` | codex-review fixes on `2314566` (nullable schemas, single-board, LiveFill prefix) |
| `2314566` | rename drifted job-bucket keys to backend canonical shape |
| `61d7d76` | Wave A audit — 170 iOS↔PWA gaps across 8 phases |

### Notes from the run so far
1. **The audit was run against `stage6-agentic-extraction`, which diverged from main in two directions.** Some gaps (Phase 5 Gap #5.5 PDF stubs, Phase 8 Gap #1 CCU three-mode, much of Phase 3 action-rail) are stage6-only regressions and **already resolved on main**. Each phase needs a "what's actually current on main" cross-check before the fix agent wastes effort.
2. **Outcome enum drift (Phase 4 Gap #9 / Gap #10) NOT yet fixed in B1.** The `ScheduleOutcome` type still includes `'✓' / '✗' / 'FI'` which iOS can't decode. This is a P0 data-corruption item and lands in B7 or a dedicated B1 follow-up.
3. **Inspection-schedule flag casing** (Phase 4 Gap #11 — `mark_section_7_na` vs `mark_section7_na`) is still snake_case on PWA pending backend-contract verification. The shared-types say camelCase; PWA doesn't. Needs a grep-and-rename pass on the inspection page.
4. **InspectorProfile shape** (Phase 5 Gap #5.3, Phase 7 P0-7B-1) — backend audit confirms single `name` field (not `firstName` + `lastName`) and NO equipment fields server-side. PWA's local 10-equipment-field extension is client-only and must stay client-only. The audit's "split-name" gap is wrong; the "3-way shape drift" gap is real and still open.
5. **Collision hazard**: the `stage6-agentic-extraction` branch is actively being committed to by a parallel Claude session. A worktree at `../EICR_Automation_parity` isolates the parity work so the two don't fight over `git checkout`. Don't reuse the main repo checkout for parity fixes.

### Codex review findings closed so far
- **B1** (`2314566`) → 4 findings, all addressed in `28556f9`: (P1) nullable-schema regression (backend emits `null` for unpopulated buckets — schemas now `.nullable().optional()`); (P1) single-board data-loss path (BoardPage now synthesises from `board_info` + writes back to both); (P2) LiveFill prefix mismatch (mapping table at the diff-emission boundary); (P2) Overview-board read vs Board-tab write inconsistency — deferred to B7's inner-field pass since the Overview reads pre-existing drifted buckets that need rationalising wholesale.
- **B2** (`86dac39`) → no findings. Clean cert-type gating.
- **B1.1 outcome+flag** (`7e88133`) → 1 finding addressed in `5cc2022`: (P1) iOS Swift `CodingKeys` map camelCase Swift property names to **snake_case JSON keys** on the wire (`is_tt_earthing` etc.), so the rename direction was wrong. shared-types had it backwards; reverted PWA to snake_case + updated shared-types to match the actual wire shape. Real divergence was just one key — `mark_section_7_na` (extra underscore) → `mark_section7_na`.
- **B3a** (`f8ab898`) → no separate codex review (small bucket-rename follow-up).
- **B6.1 dashboard** (`181fc3a`) → 1 finding addressed in `39cb5a1`: (P2) removing the cap entirely was a perf regression for inspectors with hundreds of jobs. New shape: render up to 50 by default, show a "Show all N jobs" button below when truncated.
- **B5.1 Staff tab** (`317d18d`) → 1 finding addressed in `780266a`: (P2) the new roster-fetch effect didn't clear local state on user-change or fetch-rejection, so a previous account's signatories could remain visible after a 401/403 or a failed re-fetch. Both branches now `setInspectors([])` before/after the request, collapsing the picker to its empty state and preventing wrong-account writes into `job.inspector_id`.
- **B2.1 T&Cs gate** (`06caaf9`) → 2 findings addressed in `6465a4a`: (P1) the page passed `search.get('next')` straight to `router.replace()`, so a crafted `/terms?next=https://evil.example` could bounce an authenticated user off-site post-accept — same class as the `/login?redirect=` open-redirect closed by Wave 1 P0-16, now reusing the shared `sanitiseRedirect()` helper. (P2) the AppShell gate stored only `pathname` in the `next` param, dropping query state for routes like `/job/[id]/circuits/match-review?nonce=...`; the gate now reads `useSearchParams()` and round-trips the full URL through `next`.

### Real remaining work for next session

1. ~~**InspectorProfile 3-way shape drift** (Phase 5 #5.3)~~ ✅ closed by `317d18d` (Staff page now imports `InspectorProfile` from `@/lib/types`; local `Inspector` type dropped; `full_name`/`*_serial` references rewritten to `name`/`*_serial_number`).
2. ~~**Staff roster fetch** (Phase 5 #5.1)~~ ✅ closed by `317d18d` (Staff page now fetches via `api.inspectorProfiles(user.id)` on mount; the unused `inspectors?: Inspector[]` field on the StaffJobShape was dropped). Codex P2 follow-up `780266a` clears stale state on user-change / fetch-rejection.
3. ~~**Phase 4 #12** (inline observation workflow on schedule taps)~~ ✅ already on main — audit was wrong because it ran against stage6 (`inspection/page.tsx` carries the `inlineFormRef` / `pendingChange` flow on `main`).
4. ~~**T&Cs gate** (Phase 2 P0 #1)~~ ✅ closed by `06caaf9` (`/terms` page with verbatim iOS legal text + 3-doc / 3-confirmation gate, AppShell client-side redirect, iOS-parity localStorage keys). Codex P1 + P2 follow-ups in `6465a4a` (open-redirect closed via `sanitiseRedirect`, query string preserved through the gate). One deliberate divergence: signature capture deferred (signatures live on `InspectorProfile` on web; iOS's `termsAcceptanceSignature` audit-trail blob has no web counterpart yet).
5. **Preset picker on job creation** (Phase 2 P0 #3) — ⚠️ deferred. iOS uses multiple-named `CertificateDefault` records per user (preset per cert type) backed by GRDB; web uses a single `user_defaults.json` blob applied on-demand from the Circuits tab (`/settings/defaults` is the editor, no auto-apply at job creation by deliberate architectural choice — see `web/src/app/settings/defaults/page.tsx` doc-comment). iOS's "1 preset → auto-apply, 2+ presets → picker" model doesn't translate without either schema migration on web (multi-named-preset CRUD endpoints) or a different UX (e.g., a single "Apply your defaults?" Yes/Skip sheet that doesn't match iOS's picker shape). Needs a design decision before implementation; not a single-commit follow-up.
6. ~~**Swipe delete on dashboard job rows** (Phase 2 P0 #4)~~ ✅ already on main — feature shipped in commit `9fcbeed` (Phase 3 — dashboard expiring count, swipe/context-menu delete, tour tile). Audit was wrong because stage6 had regressed it. Regression test added in this batch (`tests/job-row-swipe-delete.test.tsx`) since coverage was zero.
7. **Deepgram config drift** (Phase 6 P0s) — needs main-vs-stage6 cross-check; some flagged config gaps may be stage6-only. Once verified-on-main, focus on `utterance_end_ms`, keyterm prompting (port `KeywordBoostGenerator`), 25s ALB heartbeat.
8. **Per-circuit field drift** (Phase 3 #16, #18) — `CircuitRow` uses `id`/`number`/`description` while wire uses `circuit_ref`/`circuit_designation`. Big refactor; ladder of follow-ups.

### Deliberate divergence — needs legal review

- **T&Cs port (`06caaf9`)** — `web/src/app/terms/legal-texts.ts` carries the iOS legal text verbatim, including Apple-specific clauses (T&C §17, EULA §10/§13). These survive on web because (a) inspectors who installed iOS first already accepted them there, (b) the same operator owns both surfaces. A future legal-review pass may carve them out — log here so we don't lose track.
- **No signature capture on web T&Cs gate (`06caaf9`)** — iOS captures a finger-drawn signature into `UserDefaults["termsAcceptanceSignature"]` for an audit trail. On web, the inspector's signature already lives on their `InspectorProfile`. If legal review requires the audit trail, port `SignatureCaptureView` and add it as a fourth confirmation step.

### How to resume

1. `cd /Users/derekbeckley/Developer/EICR_Automation_parity` (the worktree, not the main checkout — the main checkout is on `stage6-agentic-extraction` and a different Claude session is actively committing there).
2. `git status` should be clean on `pwa-parity-fixes`.
3. Read `web/audit/INDEX.md` (this file) for the latest commit log + remaining work.
4. Pick a next item from the "Real remaining work" list above. T&Cs gate or InspectorProfile shape consolidation are the two cleanest single-commit follow-ups; both are isolated and well-bounded.
5. Run `npm test --workspace=web -- --run` after each change. Pre-existing TS errors in `tests/phase-6-clear-cache.test.tsx` and `tests/phase-9-haptic.test.ts` are noise (also on main); ignore.
6. Run `codex review --commit <SHA>` after each commit. The shell needs `bash -lc 'codex …'` — codex is at `/opt/homebrew/bin/codex` but its node shebang fails under the default sandboxed PATH.

## Phase status — ALL DONE

| Phase | Scope | Report | Gaps (P0 / P1 / P2) |
|-------|-------|--------|---------------------|
| 1 | Tab structure & cert-type gating | `phase-1-tab-structure.md` | 8 (4 / 2 / 2) |
| 2 | Dashboard & job list | `phase-2-dashboard.md` | 17 (7 / 7 / 3) |
| 3 | Shared job tabs (Overview, Installation, Supply, Board, Circuits) | `phase-3-shared-tabs.md` | 27 (9 / 13 / 5) |
| 4 | Cert-gated tabs (Inspection, Observations, Extent, Design) | `phase-4-cert-gated-tabs.md` | 14 (8 / 4 / 2) |
| 5 | Staff / PDF tabs | `phase-5-staff-pdf.md` | 14 (7 / 5 / 2) |
| 6 | Recording pipeline UI | `phase-6-recording.md` | 22 (7 / 10 / 5) |
| 7 | Settings (hub / staff / company / admin) | `phase-7-settings.md` | 52 (13 / 26 / 13) |
| 8 | CCU + Document extraction + Fuseboard matcher | `phase-8-ccu-and-docs.md` | 16 (6 / 7 / 3) |
| **Total** |  |  | **170 (61 / 74 / 35)** |

Exceptions (documented, intentional): 3 (Phase 3 Circuits mobile card-view; Phase 8 × 2).

## Cross-cutting themes (multiple phases)

1. **InspectorProfile shape drift (3-way)** — iOS `firstName`/`lastName` + 10 equipment fields; PWA has ≥3 incompatible shapes across `staff/page.tsx`, `lib/types.ts`, and `@certmate/shared-types`. Touches Phases 1, 5, 7. Risk: silent signature/sign-off data loss.
2. **Outcome / enum drift** — Inspection outcomes, RCD types, polarity, premises chips, OCPD ratings all have enum or casing drift between iOS and PWA (Phases 3, 4). Some PWA values crash iOS decode (`✗`, `FI`).
3. **Data-bucket / key-casing drift** — Web JSON shapes use snake_case under different section keys (`installation` / `supply` / `board.boards`) vs iOS camelCase (`installationDetails` / `supplyCharacteristics` / `boards`) and different schedule-flag keys (`mark_section_7_na` vs iOS `mark_section7_na`). Phases 3, 4.
4. **Dead / orphan code from rebuild refactors** — `LiveFillView` imported nowhere (Phase 6); `sendJobStateUpdate` defined but uncalled (Phase 8); `/observations` route orphaned (Phase 1); three Circuits action-rail buttons stubbed (Phase 3). Cosmetically the features exist; functionally they don't.
5. **Deepgram config drift** — `utterance_end_ms`, keyterm prompting, 25s heartbeat, 3-tier VAD all diverge (Phase 6). Direct violation of the global rule in `~/.claude/rules/mistakes.md`.
6. **Missing whole subsystems on PWA** — Defaults (Phase 7), Change Password (Phase 7), 3-mode CCU matcher + review sheet (Phase 8), Terms & Conditions gate (Phase 2), preset picker on job creation (Phase 2), PDF generation (Phase 5 — Generate/Preview/Share are stubs).

## P0 — functional or gating bugs (61)

### Phase 1 (4)
- [ ] [Phase 1#gap-1] Observations orphaned on EICR (tab removed, replacement FAB button never built)
- [ ] [Phase 1#gap-2] FAB only renders Mic — no Obs button despite the comment claiming there is one
- [ ] [Phase 1#gap-3] Extent tab shown on EICR; iOS gates to EIC
- [ ] [Phase 1#gap-4] Design tab shown on EICR; iOS gates to EIC

### Phase 2 (7)
- [ ] [Phase 2] No Terms & Conditions gate after login — iOS `RootView` blocks until signed
- [ ] [Phase 2] Recent Jobs hard-capped at 8 with no "view all"; jobs >8 unreachable
- [ ] [Phase 2] No preset picker / Defaults entry on job creation (iOS `autoApplyDefaults` flow absent)
- [ ] [Phase 2] No swipe / overflow delete on job rows
- [ ] [Phase 2] Setup & Tools missing Defaults + Tour tiles
- [ ] [Phase 2] (2 more — see phase-2 report)

### Phase 3 (9)
- [ ] [Phase 3#gap-1] Tab-data buckets diverge (`installation`/`supply`/`board.boards` vs iOS `installationDetails`/`supplyCharacteristics`/`boards`) — root cause of many field misses
- [ ] [Phase 3#gap-28] Circuits action-rail: Delete / Apply Defaults / Calculate are "not available yet" stubs
- [ ] [Phase 3#gap-16] Earthing-conductor continuity: free-text on web, PASS/FAIL/LIM on iOS
- [ ] [Phase 3#gap-18] Bonding / extraneous-bond continuity: same divergence
- [ ] [Phase 3] TT side-effects, main-switch pickers, missing circuit fields, Fed-from picker (4 more — see phase-3 report)

### Phase 4 (8)
- [ ] [Phase 4#gap-9] Inspection outcome enum divergence — PWA `✗`, `FI` crash iOS decode; iOS `NV` absent on PWA
- [ ] [Phase 4#gap-10] Inspection items shape: iOS tagged object vs PWA bare Record — iOS silently wipes all rows when web-saved EICR opens on iPhone
- [ ] [Phase 4#gap-11] Schedule flag key drift `mark_section_7_na` (PWA) vs `mark_section7_na` (iOS canon) — supersedes Phase 1 Gap #6
- [ ] [Phase 4#gap-12] No linked-observation plumbing: tapping C1/C2/C3 on a schedule row does nothing beyond setting the outcome string
- [ ] [Phase 4] (4 more — see phase-4 report)

### Phase 5 (7)
- [ ] [Phase 5#gap-5.5] PWA PDF Generate / Preview / Share are disabled stubs — inspectors must still open iOS to produce a cert
- [ ] [Phase 5#gap-5.1] Staff roster never fetched (`api.inspectorProfiles` has no call site) — every role picker permanently empty — carries Phase 1 Gap #5
- [ ] [Phase 5#gap-5.3] Three incompatible InspectorProfile shapes in the repo (silent data-disappearance latent under the fetch bug)
- [ ] [Phase 5] (4 more — see phase-5 report)

### Phase 6 (7)
- [ ] [Phase 6] LiveFillView imported nowhere — the entire live dashboard is dead code
- [ ] [Phase 6] Deepgram `utterance_end_ms` drift: PWA 2000 vs iOS 1500
- [ ] [Phase 6] No keyterm prompting on PWA Deepgram URL (iOS passes ~89 boost-scored keyterms; PWA 0)
- [ ] [Phase 6] No 25s ALB-defeating heartbeat; no Sonnet question rendering; 2-tier field priority instead of 3-tier; no regex layer; no transcript buffering during reconnect; no `observation_update` handler (several more — see phase-6 report)

### Phase 7 (13)
- [ ] [Phase 7#P0-7F-1] Entire Defaults area absent from PWA (no `/settings/defaults/*` route)
- [ ] [Phase 7#P0-7G-1] Change Password page entirely missing
- [ ] [Phase 7#P0-7B-1] Inspector `firstName`/`lastName` vs flat `name` drift — PWA profiles land on iOS with empty lastName
- [ ] [Phase 7#P0-7D-3] Admin/create: company picker is a free-form UUID input
- [ ] [Phase 7#P0-7C-1] Company: 5-field address collapsed to one textarea
- [ ] [Phase 7#P0-7D-6] Failed-login-attempts counter absent
- [ ] [Phase 7#P0-7H-1] Version / About section absent
- [ ] [Phase 7#P0-7E-2] Employee filter missing on company dashboard
- [ ] [Phase 7#P0-7B-2] `organisation` + `enrolment_number` write-only from PWA / invisible on iOS detail view
- [ ] [Phase 7] (4 more — see phase-7 report)

### Phase 8 (6)
- [ ] [Phase 8#gap-1] PWA has no three-mode CCU selector (Names-only / Hardware-update / Full) — inspectors cannot pick correct merge behaviour
- [ ] [Phase 8#gap-3] Fuzzy matcher absent — PWA keys by `circuit_ref` only, renumbered boards silently re-attach readings to wrong circuits
- [ ] [Phase 8#gap-2] No `CircuitMatchReviewView` on PWA — hardware-update applies patches immediately with no user-visible diff
- [ ] [Phase 8#gap-4] `sendJobStateUpdate` defined but uncalled — Sonnet snapshot goes stale after mid-session CCU updates
- [ ] [Phase 8#gap-5] No pending-extractions queue — lost photos on network failure
- [ ] [Phase 8#gap-13] No PDF document-extraction support (iOS renders PDFs locally)

## P1 — polish / drift (74)

Full list in each phase report. Notable themes: postcode autocomplete, inspection-years picker, inline inspector pickers, RCD quick-set buttons, N/A previous-date, confirm-dialog copy, WideCircuitsPanel column order, hero-key drift, PDF warning-set drift (iOS 3 vs PWA 7-9, disjoint), cost-display format, and 10 Deepgram-config tuning gaps. See each phase's **## Gap #N** entries marked `[P1]`.

## P2 — code-only drift (35)

Dead props, JSDoc referencing non-existent memos, shared-types backports, unused type parameters. See each phase report.

## Exceptions — intentional divergence (3)

- **Phase 3** — Circuits mobile card-view (author-flagged as deliberate trade-off at `web/src/app/job/[id]/circuits/page.tsx:30-47`).
- **Phase 8** — 2 documented exceptions (see phase-8 report).

## Open questions still outstanding

- **[Phase 1 Q3 / Phase 4]** Inspection schedule flag wire-key: iOS emits `mark_section7_na`; PWA `mark_section_7_na`. Phase 4 says iOS is canonical. Verify the backend column's actual stored key before choosing "rename column" vs "alias both in API layer".
- **[Phase 4 / Phase 5]** Outcome / InspectorProfile drift: before fixing the PWA, confirm whether any live production data on `eicr-db-production` has already been written in the drifted shapes. If yes, a migration/backfill is needed alongside the client fix.

## Recommended next steps (Wave B — fix)

Given 61 P0s, fix in priority order of **blast radius**, not phase order:

1. **Data-shape P0s first** (schedule items, outcome enums, tab data buckets, InspectorProfile, schedule-flag casing) — Phases 3/4/5/7. These are the cross-platform data-corruption risks; fix them before any round-trip tests run.
2. **Structural tab/nav P0s** — Phase 1 (4 gaps) + Phase 2 T&Cs gate + Phase 2 job list cap. Small file counts, high user impact.
3. **Subsystem stubs** — PDF generation (Phase 5), Change Password (Phase 7), Defaults (Phase 7), three-mode CCU matcher + review (Phase 8). Biggest code effort; schedule deliberately.
4. **Deepgram + Recording config drift** — Phase 6 (all P0s in one file). Ship once tested against a recording session.
5. **P1s swept in batches by file** — group by `web/src/app/job/[id]/*/page.tsx` so each PR touches ~1 file.
6. **P2s last** — mechanical cleanup, low value, do in a single "hygiene" PR.
