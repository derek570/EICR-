---
name: certmate-change-control
description: >
  Load BEFORE making, planning, reviewing, or committing ANY change in the
  EICR_Automation repo. Defines how changes are classified and gated here:
  the six MANDATORY rules (backend-immutable during parity work,
  infrastructure-from-source, web-companion for client-visible changes,
  parallel-workstream shared-test-file rule, deploy-via-CI-only,
  auto-commit/auto-push policy with its exclusions), each with the historical
  incident that created it. Also the docs-of-record discipline: hub CLAUDE.md
  is an index only, changelog row format, parity-ledger row format, the
  documentation sync rules, and the house commit style ([contract],
  [skip-drift-check], field-session IDs). Do NOT load this for how to run
  tests (certmate-validation-and-qa), how to deploy step-by-step
  (certmate-run-and-operate), or how to debug a failure
  (certmate-debugging-playbook).
---

# CertMate Change Control

How changes are classified, gated, documented, and committed in
`EICR_Automation`. Every rule below exists because its absence cost real
field-test time. Nothing here is advisory — the six rules in §2 gate all
changes: §2.1–2.4 and §2.6 carry the hub `CLAUDE.md`'s five MANDATORY
blockquotes, and §2.5 (deploy via CI only) plus §2.6's auto-push half are
hub Deploy-section policy. Authority split if this file ever disagrees with
the repo: the hub wins on RULES; source templates/code win on current-state
FACTS (the §2.2 corollary — believe the template, fix the doc).

**Definitions used throughout:**
- **Hub** = the repo-root `CLAUDE.md` (an index; detail lives in `docs/reference/*`).
- **Parity work / the parity program** = the iOS↔Web Full-Parity Program (workstreams WS0–WS9) making the Next.js PWA in `web/` match the iOS app (`CertMateUnified/`, a SEPARATE nested git repo, canon for the data contract).
- **Ledger** = `web/docs/parity-ledger.md`, the per-surface iOS↔web gap register.
- **Task def** = an ECS task definition; source templates are `ecs/task-def-backend.json` and `ecs/task-def-frontend.json`.
- **Drift** = any difference between live AWS state and its source-controlled template.

## 1. Classify the change FIRST

Before touching a file, classify. The classification decides which gates apply.

| You are about to touch… | Classification | Gates that apply (§) |
|---|---|---|
| `web/` only, no wire/HTTP shape change | PWA-only | §2.4 (if shared test files), §2.6, §3 |
| `src/`, `config/prompts/*.md`, `packages/shared-types`, `packages/shared-utils`, RDS schema, S3 layout | **Backend (SHARED with iOS)** | §2.1 STOP-check, §2.3, §2.6, §3 |
| `ecs/*.json`, `.github/workflows/deploy.yml`, IAM, secrets, any live AWS resource | Infrastructure | §2.2, §2.6, §3 |
| `web/tests/setup.ts`, `web/vitest.config.ts`, or test files another in-flight PR also touches | Shared test harness | §2.4 |
| Anything a voice/web/iOS user can see or hear (new wire fields, spoken UX, visible behaviour) | Client-visible | §2.3 web-companion, §3 |
| `config/field_schema.json` or extractable-field surface | Field-schema | §4.3 sync rules |
| Docs only | Docs | §4.1–§4.2 formats |

A change can carry multiple classifications; apply the union of gates.

## 2. The six MANDATORY rules

### 2.1 Backend is IMMUTABLE during PWA/parity work

**Rule:** PWA bug fixes, parity work, and UI tweaks land in `web/` ONLY. Do
NOT touch `src/`, `config/prompts/*.md`, `packages/shared-types`, or
`packages/shared-utils` without an explicit cross-platform mandate from the
user. iOS is canon for the data contract — close data-shape gaps by moving
the PWA to match the backend's CURRENT shape, never the reverse.

**Why:** iOS already runs against the current backend shape; any backend
change risks an iOS regression and a TestFlight cycle. The parity program was
explicitly scoped "zero backend changes" (Derek, 2026-07-01).

**Incident:** between 2026-06-17 and 2026-07-01, ~8 voice waves shipped
backend+iOS companions and ZERO web companions — the two-client drift that
the whole parity program (WS0–WS9) exists to repay. Earlier still, the repo
ran TWO web frontends (`web/` + retired `frontend/`) and nearly every bug
regressed because fixes landed in only one.

**How to apply:** before editing anything outside `web/`, ask: "does this fix
change behaviour that iOS sees?" If yes → surface it to the user BEFORE
touching it. If a PWA gap truly cannot be closed without a backend change →
escalate; never bundle a backend tweak into a PWA fix. Pure-frontend state
(anything that never crosses the WS/HTTP boundary) is exempt.

### 2.2 Infrastructure changes must come from source

**Rule:** any change to an ECS task def, IAM policy, secret, env var, or
other live AWS resource is canonical ONLY as a commit to the source file
(`ecs/task-def-backend.json`, `ecs/task-def-frontend.json`,
`.github/workflows/deploy.yml`, …). Direct `aws ecs register-task-definition`,
console edits, or any out-of-band CLI mutation is at most an emergency
stopgap and MUST be followed by a source commit in the same session.

**Why:** every CI deploy re-registers the task def from the source template.
Live-only edits are silently dropped on the next deploy, with no warning.

**Incidents (twice):**
- `JWT_SECRET` added live to the `eicr-pwa` task def 2026-04-19 → dropped by
  the next re-registration → PWA login bounced TWICE in two days. Permanent
  fix committed the secret to source: `c918b88a` ("add JWT_SECRET to PWA
  task-def source so deploys stop dropping it", 2026-04-19).
- `CCU_DEWARP_OUTPUT_WIDTH=2048` set live 2026-05-13 → dropped by the
  2026-05-14 CI deploy → regression resurfaced days later, costing a
  half-day of forensics. Fix moved the default into code (`01c081e5`,
  2026-05-22) and added the CI guardrail (`abe14858`, same day).

**Guardrails (both run in CI before `register-task-definition`):**
- `scripts/check-task-def-env-drift.sh <service> <template>` — fails the
  deploy if any env var exists on the LIVE task def but not in the source
  template (i.e. a live hotfix the deploy would silently strip).
- `scripts/audit-env-var-source.sh ecs/task-def-backend.json` — the opposite
  direction: code reads `process.env.X` but the template (and allowlist)
  never defines it, so prod silently runs the fallback.

**Bypass:** put `[skip-drift-check]` in the commit message (sets
`ALLOW_TASKDEF_DRIFT` in `deploy.yml`). Emergencies ONLY — it has been used
once as an actual bypass in repo history (`61bfe1d9`; `abe14858` is the commit
that INTRODUCED the mechanism and merely mentions the marker in its body) —
and always follow up with a real source commit immediately.

**Pre-flight question before ANY mutating `aws ...` command:** "does this
change persist to source?" No → stop, edit the source file instead. Yes →
run it AND commit the source change.

**Corollary — task-def source is the truth for prod values.** Example: as of
2026-07-06, `ecs/task-def-frontend.json:31` sets `DEEPGRAM_STT_MODEL=flux`
(intentional flip `ff620997`, 2026-07-03); an older hub changelog row still
says "default stays nova3". When docs and the task-def template disagree,
believe the template and fix the doc.

### 2.3 Web companion required for every client-visible change

**Rule:** every plan/wave that changes voice UX, wire shapes, or
client-visible behaviour MUST contain a "Web companion" section: either the
web change ships in the same wave, or a dated `web/docs/parity-ledger.md`
row **with an owner** plus a todo records the deliberate lag. "Deferred with
no owner" is not an allowed state.

**Why / incident:** the iOS+backend ship loop (field feedback → plan →
TestFlight + ECS deploy) had no web step; the ~8-wave drift of §2.1 left
MANDATORY audio-first behaviour (universal read-back) dormant for web users.
This rule is WS1's drift-stop.

**Enforcement:** CI job `parity-ledger-warn` (PR-only, `continue-on-error`,
warn-only by contract — the script ALWAYS exits 0) runs
`scripts/check-parity-ledger.mjs`, which maps the PR's changed files through
`web/docs/parity-ledger-files.json` (file path → ledger row `id`s) and emits
`::warning::` for rows whose `last-verified` is blank, invalid, or >30 days
old. It never blocks; treat the warnings as a review checklist, not noise.

**How to apply when reviewing/writing a plan:** ask "does a web user see this
change?" If yes and there is no Web-companion section → add one, or add the
dated ledger row + owner + todo, before the plan converges.

### 2.4 Parallel workstreams over shared test files: re-run `main`'s full suite between merges

**Rule:** when two or more PRs run in parallel and touch OVERLAPPING test
files or the shared web test harness (`web/tests/setup.ts`,
`web/vitest.config.ts`), do NOT merge each on green-in-isolation. After a
merge to `main`, re-run the FULL suite on `main` (backend Jest AND
`npm test --workspace=web`) BEFORE the next PR merges. If `main` goes red,
fix-forward before merging the next — never stack.

**Why / incident:** WS5 and WS7 (2026-07) both touched the terms tests; each
PR was green in isolation, but their interaction surfaced only on the
post-merge `main` run — which then SKIPPED the deploy, because the deploy
jobs depend on the frontend test job passing. Green-in-isolation ≠
green-after-merge when the shared harness is what changed.

**Local gate:** `.husky/pre-push` runs BOTH suites
(`npm test && npm test --workspace=web`) on a best-effort Node-20 (`nvm use`
against `.nvmrc`; `web/scripts/check-node.mjs` warns on a mismatched major —
the dev box runs Node 25 and jsdom behaviour differs by major, the "green
locally / red in CI" class). After any merge into `main` that touched test
infra, watch the `main` CI run to green before the next merge.

### 2.5 Deploy via GitHub Actions ONLY

**Rule:** push to `main` → CI tests, builds ARM64 images, deploys to ECS
(~30 min end-to-end). Monitor with `gh run watch <run-id> --exit-status`
(one long-poll connection — never poll `gh run list` in a loop). NEVER use
the local `./deploy.sh` even though it exists at repo root: Docker Desktop is
not kept running on the dev box, the script fails immediately, and its
`tee`-wrapped invocation masks the failure as exit 0.

**Know what CI does and does not gate (as of 2026-07-06, `deploy.yml`):**
- BLOCKING: backend Jest, web `next build`, web vitest, Trivy CRITICAL,
  both drift guards (§2.2), the migrations one-off task (backend deploys run
  `node scripts/migrate-from-secrets.js` as a Fargate one-off; non-zero exit
  halts the deploy — born from the `cert_attestations` 500, `b50a37fb`,
  2026-05-29).
- NON-blocking: eslint and `tsc --noEmit` are `|| true` in CI. "CI is green"
  does NOT mean lint/typecheck-clean — check those locally.
- `frontend-taskdef` fast path: a commit whose changed-file set is EXACTLY
  `ecs/task-def-frontend.json` skips the rebuild and just re-registers the
  task def + rolls `eicr-pwa` (~3–5 min). This is the sanctioned runtime
  kill-switch flip path (e.g. `DEEPGRAM_STT_MODEL`).

Deploy step-by-step mechanics live in `certmate-run-and-operate`.

### 2.6 Auto-commit and auto-push policy

**Commit:** commit automatically after EACH logical unit of work — do not
wait to be asked. One concern per commit; multiple small commits beat one
large one. Every code change updates docs (§4) in the same unit of work.

**Push:** at end of a work session, when backend changes are committed on
`main` (or a merged feature branch) and `npm test` is green, push to
`origin/main` automatically. Default is auto-push. The ONLY reasons to hold:

| Hold auto-push when… |
|---|
| `npm test` is failing — never ship red |
| Work is on a feature branch awaiting PR/review |
| A pre-push hook fails — investigate; NEVER bypass with `--no-verify` |
| The user explicitly said "don't push" for THIS task |
| Schema/migration change needing iOS coordination — push backend FIRST, `gh run watch` the ECS rollout to green, THEN start the iOS TestFlight push, so iOS lands on a backend with the new shape live |

## 3. Docs of record — what must be updated with every change

Hub `CLAUDE.md` is an **index only**. Add detail to `docs/reference/*` files,
never to the hub. Delete stale content rather than commenting it out.

| Change type | Update, in the same session |
|---|---|
| Any user-facing or architectural change | One-line row in the hub Changelog table + a full commit-body-level entry at the top of `docs/reference/changelog.md` |
| Pipeline step / field / architecture change | The matching `docs/reference/*.md` file (architecture.md, ios-pipeline.md, field-reference.md, deployment.md, …) |
| Any web parity surface touched | Its `web/docs/parity-ledger.md` row: status + `last-verified` date (§4.2) |
| UI field change | §4.3 sync rules |

Docs updates are not optional follow-ups; a change without its doc row is an
incomplete change. (The `[contract]`-marker commit `e3c67560` is a model
example: a docs-only commit whose body explains it exists BECAUSE of this
rule.)

## 4. Formats of record

### 4.1 Changelog rows

- Hub `CLAUDE.md` Changelog: `| YYYY-MM-DD | one-line summary |` — newest
  first; older rows periodically pruned to `docs/reference/changelog.md`.
- `docs/reference/changelog.md`: same date + a FULL commit-body-level entry
  (what/why/approach/test counts/ledger rows touched). This file is the
  permanent record; the hub row is the pointer.

### 4.2 Parity-ledger rows (`web/docs/parity-ledger.md`)

Column format (verified 2026-07-06):

```
| id | ios-ref | web-ref | status | last-verified | phase | notes |
```

- `id` — stable slug (e.g. `recording/tts-fifo`, `pdf/pdf-fidelity`). NEVER
  renumber, NEVER reuse; new rows get a fresh id. `web/docs/parity-ledger-files.json`
  maps web file paths → row ids for the CI staleness warner; register new
  parity-relevant files there when you add rows.
- `last-verified` — ISO date you actually re-checked the row against CURRENT
  iOS + web source. Blank counts as stale. **Never fabricate this date.**
- `status` legend: `match` (behaviourally+visually equivalent) / `partial`
  (some behaviour present; per-row note says what's missing and, for
  deliberate divergences, carries a DATED note + owner) / `missing` /
  `ios-only` (intentional platform divergence). **`backend` was RETIRED
  2026-07-02** — no active row may carry it; anything that appears to need
  backend work must be rewritten as a dated deliberate-divergence /
  blocked-by-zero-backend note with an owner, or re-scoped frontend-only.
- iOS refs are paths relative to the `CertMateUnified/` repo with
  `file:line` spans; web refs relative to this monorepo root.

### 4.3 Documentation sync rules (field/extraction surface)

- Modify a UI field → update `config/field_schema.json` (the source of truth
  for fields; tool schemas generate `record_reading` enums from it at module
  load) AND the matching table + "Keeping This Documentation in Sync"
  discipline in `docs/reference/field-reference.md`.
- Add an extractable field to the live (Sonnet/Haiku) extraction — the
  TRIPLE, all three or the field silently under-performs:
  1. Add it to the prompt in `src/extraction/eicr-extraction-session.js`;
  2. Add a case in iOS `applySonnetReadings()` (CertMateUnified repo —
     `scripts/check-ios-field-parity.mjs`, run via `npm run check:ios-parity`,
     checks every `field_schema.json` entry has one);
  3. Add keyword boosts in `default_config.json` — that file lives in the
     **CertMateUnified repo** (`CertMateUnified/Sources/Resources/default_config.json`),
     NOT in backend `config/`. TRAP: `CertMateUnified/Resources/default_config.json`
     is a stale twin — editing it does nothing to the shipped app (see
     certmate-config-and-flags §6 for the canonical-copy determination).
     The web twin for STT boosts is
     `web/src/lib/recording/keyword-boosts.ts`; keep iOS/web Deepgram config
     in sync as a SET.
- Field-schema changes are BACKEND-classified (§2.1 stop-check applies).

## 5. House commit style

Format: `type(scope): subject`, then a blank line, then a multi-paragraph
body answering **What / Why it was needed / Why this approach / Context**
(deliberate UI decisions, whether it fixes fallout of a prior refactor,
consistency choices). Types in live use: `fix`, `feat`, `test`, `docs`,
`chore`, `refactor`, `perf`, `ci`, `revert`. Scopes are domain slugs:
`(ccu)`, `(web/tts)`, `(voice/#2b)`, `(stage6)`, `(ecs)`, `(ir)`,
`(migrations/009)`, `(prompt)`, `(gate)`.

Markers and conventions (all verified in `git log`):

| Marker | Meaning | Example |
|---|---|---|
| `[contract]` | Tags a deliberately DEFERRED cross-platform wire-contract item (needs a coordinated iOS+backend cycle) | `e3c67560`, `3b0940d6` |
| `[skip-drift-check]` | Bypasses the task-def drift CI gate (§2.2) — emergencies only, source commit must follow | `61bfe1d9` |
| Field-session IDs | Provenance for field-test-driven fixes: the session ID + defect number in the subject | `fix(ir): … (F1AC26FB #4)` = `88e5a320` |
| `WS0`–`WS9` / ledger ids | Parity-program workstream + the ledger rows a change moves | `feat(web/stt): flip web Deepgram to Flux (WS4 kill-switch…)` |
| `ep/PLAN-<timestamp>-ep` branches | Autonomous plan-execution worktrees; merged via PR (`Merge pull request #NN from derek570/ep/…`) | PR #85 |
| Co-authorship footer | Near-universal on assistant-authored commits; use the footer your harness mandates | — |

Revert commits state the lesson in the subject, not just the undo:
`revert(ccu): remove board-majority guessing — blank > guessed wrong`.
Failed experiments get a `docs(...)` commit recording WHY they failed (e.g.
`0dadcbbd` EDGE_SEARCH_PAD) so the next session doesn't retry them.

## 6. Pre-flight checklist (run before every unit of work)

1. Classify via §1 table. Backend-classified + parity context → STOP and
   confirm mandate (§2.1).
2. Mutating AWS command queued? → source-first (§2.2).
3. Client-visible? → web companion or dated ledger row + owner (§2.3).
4. Touching shared test files with another PR in flight? → plan the
   post-merge full-suite re-run on `main` (§2.4).
5. After the change: docs rows (§3), ledger `last-verified` (§4.2), sync
   triple if field-surface (§4.3).
6. Commit per §5; push per §2.6 unless an exclusion applies.
7. Deploy only via CI; watch with `gh run watch <id> --exit-status` (§2.5).

## 7. When NOT to use this skill

| You actually want… | Load instead |
|---|---|
| Symptom→triage for a live failure | `certmate-debugging-playbook` |
| The full story of a past investigation/revert | `certmate-failure-archaeology` |
| Why the system is designed this way (invariants) | `certmate-architecture-contract` |
| Test suites, harness footguns, what counts as evidence | `certmate-validation-and-qa` |
| Step-by-step deploy/rollback/ECS commands | `certmate-run-and-operate` |
| Env-var / flag catalog and how to add one | `certmate-config-and-flags` |
| Local environment setup | `certmate-build-and-env` |
| Wire-protocol frame shapes | `certmate-voice-wire-protocol` |
| Electrical domain terms (EICR, Zs, LIM, C1/C2/C3) | `bs7671-domain-reference` |
| Measurement/analysis tooling | `certmate-diagnostics-and-tooling` |
| CCU photo pipeline detail | `certmate-ccu-pipeline` |
| Latency campaign execution | `certmate-latency-campaign` |

## 8. Provenance and maintenance

All facts verified against the repo 2026-07-06. Re-verify before relying on
volatile ones:

| Fact | One-line re-verification |
|---|---|
| MANDATORY rule wording | `sed -n '1,60p' CLAUDE.md` |
| Incident hashes/dates | `git log --oneline -1 c918b88a 01c081e5 abe14858 d5adb2e3 b50a37fb ff620997 88e5a320` (run per hash) |
| Drift-guard scripts exist + usage | `head -25 scripts/check-task-def-env-drift.sh scripts/audit-env-var-source.sh` |
| `[skip-drift-check]` wiring | `grep -n 'skip-drift-check\|ALLOW_TASKDEF_DRIFT' .github/workflows/deploy.yml` |
| CI lint/typecheck non-blocking | `grep -n '|| true' .github/workflows/deploy.yml` |
| `frontend-taskdef` fast path | `grep -n 'frontend-taskdef' .github/workflows/deploy.yml` |
| Pre-push runs both suites | `cat .husky/pre-push` |
| Pre-commit secrets grep | `cat .husky/pre-commit` |
| Ledger columns + status legend | `sed -n '1,50p' web/docs/parity-ledger.md` |
| Ledger warner behaviour (30-day window, exits 0) | `head -35 scripts/check-parity-ledger.mjs` |
| File→row-id map | `head -12 web/docs/parity-ledger-files.json` |
| Prod STT value (template = truth) | `grep DEEPGRAM_STT_MODEL ecs/task-def-frontend.json` |
| Sync-rule triple paths | `ls src/extraction/eicr-extraction-session.js CertMateUnified/Sources/Resources/default_config.json web/src/lib/recording/keyword-boosts.ts` |
| Field-parity checker | `npm run check:ios-parity` |
| Sync checklist in field-reference | `grep -n 'Keeping This Documentation in Sync' docs/reference/field-reference.md` |
| Marker usage in history | `git log --oneline --grep='\[contract\]'` and `git log --oneline --grep='skip-drift-check'` |
