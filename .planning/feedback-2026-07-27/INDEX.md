# Field-feedback wave 2026-07-27 — plan index

Source: 12 voice-feedback reports (ids **102–113**) pulled from prod (`voice_feedback` table via `GET /api/voice-feedback/admin/all` + CloudWatch `"Voice feedback captured"` rows + S3 `debug-reports/`). Sessions `2C297353`, `CCFE039C`, `BE1C53C0`, all 2026-07-27 08:47–10:35 UTC, **iOS build 421** against the **pre-A–G-wave backend** (first wave deploy 2026-07-27T14:39Z; the session's advertised capabilities carry no `board_clear_v1` — triple-confirmed via deploy log, task-def revision, and `voice_latency.startup_log`).

**Verification status: every id below was re-verified against 2026-07-29 `main` (post A–G).** Verdicts come from three completed investigation agents, including in-process probes driving the real dialogue engine with Derek's verbatim wording. **None of the 11 real bugs is fixed by the shipped wave** — they live in subsystems it did not touch. id **111** is a POSITIVE report (ring correction worked), not a bug. id **78** (2026-07-14, session F5D22332) is a separate orphan — never triaged in any wave; follow-up below.

| Plan | Feedback ids | Repo(s) | Review lane | Verification lane |
|---|---|---|---|---|
| [Plan 1 — dialogue-engine correction paths](plan-1-dialogue-correction-paths.md) | 105, 109, 110(b), 113 | backend only | full dual-reviewer (session-state machine) | in-process engine probes + replay parity + unit |
| [Plan 2 — silent partial failure](plan-2-silent-partial-failure.md) | 102, 103, 104, 112 | backend (+ CloudWatch Phase 0) | full dual-reviewer (dispatcher/audibility state) | unit + recorded fixture where lockable; Phase-0 CloudWatch diagnostics first |
| [Plan 3 — observation regulation integrity](plan-3-observation-regulation-integrity.md) | 107 | backend (prompt + refinement pipeline) | full dual-reviewer (overwrite semantics; prompt decision-table upfront) | unit + LIVE-lane probes post-deploy |
| [Plan 4 — post-wake recovery](plan-4-post-wake-recovery.md) | 106, 108, 110(a) | iOS + web (client-only) | full dual-reviewer (multi-client) | unit both clients + device smoke (TestFlight + web deploy) |

## Recommended execution order

1. **Plan 1** — the failure Derek hits every inspection (correction/entry paths); backend-only, ships alone; densest verified-repro set.
2. **Plan 2** — Audio-First #1 data-integrity class (writes skipped/rejected with nothing spoken); backend-only. Run its Phase-0 CloudWatch diagnostics before authoring the 112/102 fix halves.
3. **Plan 3** — certificate correctness (wrong regulation into a legal document); prompt + pipeline; live-lane verification, so ship after the deterministic layers are stable.
4. **Plan 4** — multi-client (one TestFlight build + one web deploy); last because it needs Derek to install a build.

## Split / churn notes (planning.md rule)

- **Plan 1 trips the "3 distinct mechanisms in one high-interaction subsystem" heuristic** (entry gating / correction slots / drain ordering). Derek chose the four-plan shape; the internal seams are marked in the plan (§ Fix groups A/B/C) and a **mid-refine split along those seams is pre-authorised** if one group churns while another converges.
- Plan 2's fix for id 112 depends on a Phase-0 answer (model-side vs silent-rejection). Do not let reviewers churn on both branches — Phase 0 picks ONE.
- Plan 3: draft the prompt decision table (which observation class cites what, when to ask) **before** round 1 — the main-earth-ship run proved patch-per-finding ordering churn is the failure mode for multi-condition prompt rules.

## Integration notes across seams

- Plans 1 and 2 both add speech on previously-silent paths. All new wording rides the existing field-nil confirmation channel — no wire-shape change — and must stay string-distinct from every existing apology/notice family (client 30 s text-keyed dedupe; the plan-B rendered-notice inventory sweep is the enforcement point).
- Plan 1's id-105 fix makes the IR exclusive-voltage branch wire-emit its drained writes; plan 2's audibility work must not double-speak those (the engine read-back already owns them). One integration test across the seam.
- Plan 2 extends the plan-B `mandatoryNotices` machinery (net 0) to partially-rejected mixed turns — plan B explicitly left recoverable rejections silent on the claim they were "fail-audible"; that claim is now known false for mixed turns. Cite plan B's contract tests and extend, don't fork.
- Plan 4 is client-only by design: the backend orphan nets observed in CloudWatch are the *correct reaction* to upstream client audio loss. Any temptation to add a backend signal goes to a follow-up, not this wave.
- Shared-test-file rule: plans 1 and 2 both add tests under `src/__tests__/`/dialogue-engine — if run as parallel workstreams, re-run the full backend suite on `main` between merges (MANDATORY hub rule).

## Follow-ups (not in any plan — queue separately)

- **id 78** (session F5D22332, 2026-07-14): zero repo references — pull its S3 debug-report, triage, and either fold into a plan or `wontfix` it with a reason.
- **Triage hygiene**: every `voice_feedback` row is still `open`. After this wave ships, PATCH ids 68–101 → `actioned` (and 111 → `reviewed`, positive) so the next reconstruction isn't archaeology.
- **`bpg4_basis` dead channel** (found during id-107 verification): the prompt instructs citing `bpg4_basis` but `record_observation`'s tool schema omits it with `additionalProperties:false` — the reasoning-provenance channel is structurally dead. Logged in plan 3 §Risks as an explicit non-goal; needs its own small plan.
- **Doc drift** beyond plan 4's scope: two stale source comments cite `RecordingSessionCoordinator.swift:530-577` for a function now at `:607-654` (fixed in plan 4); hub `CLAUDE.md:233` 3-tier claim (fixed in plan 4).
