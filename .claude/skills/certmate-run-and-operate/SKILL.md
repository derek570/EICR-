---
name: certmate-run-and-operate
description: >
  Load when deploying, releasing, rolling back, or checking production for CertMate/EICR:
  reading or debugging the CI pipeline (.github/workflows/deploy.yml), understanding which
  jobs block vs advise, the frontend-taskdef fast path / DEEPGRAM_STT_MODEL kill-switch flip,
  the DB-migrations one-off Fargate task, watching a deploy with gh run watch, ECS service
  status, CloudWatch log tailing, rollback (image or config), health endpoints, Secrets
  Manager layout, S3 path conventions, session-analytics debug logs, TestFlight pointer,
  or the auto-push-at-end-of-session policy. Do NOT load for local dev setup
  (certmate-build-and-env), interpreting diagnostic data (certmate-diagnostics-and-tooling),
  test-suite/evidence questions (certmate-validation-and-qa), or change-classification
  policy rationale (certmate-change-control).
---

# CertMate — Run and Operate (deploy, monitor, roll back)

All facts verified against the repo as of 2026-07-06. Repo root: the `EICR_Automation` checkout (GitHub `derek570/EICR-`). All AWS commands assume `--region eu-west-2` unless shown.

**Definitions used below**
- **ECS** — AWS Elastic Container Service; cluster `eicr-cluster-production` runs everything (Fargate, ARM64).
- **Task definition (task def)** — the ECS container spec (image, env vars, secrets). Source of truth is IN THE REPO: `ecs/task-def-backend.json`, `ecs/task-def-frontend.json`. CI re-registers from these files on every deploy — a live-only AWS edit is silently wiped by the next deploy.
- **PWA** — the Next.js web client (`web/`), served at https://certmate.uk by ECS service `eicr-pwa`.
- **Backend** — Node/Express API + WebSocket server (`src/`), served at https://api.certmate.uk by ECS service `eicr-backend`.

## 0. Golden rules (non-negotiable, from CLAUDE.md)

1. **Deploy ONLY via GitHub Actions** (push to `main` → CI). Never run local `./deploy.sh` — Docker Desktop is not running on the dev box and the script's `tee` wrapper masks failure as exit 0.
2. **Never edit live AWS resources as the canonical change.** Task-def/env/IAM/secret changes go into the source files (`ecs/*.json`, `.github/workflows/deploy.yml`) and get committed. Emergency live edits must be followed by a source commit the same session. Rationale + incident history: see `certmate-change-control`.
3. **Monitor CI with ONE long-poll connection, never a polling loop:**
   ```bash
   gh run list --limit 5                      # find the run id
   gh run watch <run-id> --exit-status        # blocks until done; exit code = run result
   ```
   Tight HTTP polling loops have exhausted the macOS ephemeral-port range before (TIME_WAIT pile-up). One `gh run watch` per run, foreground.

## 1. Production topology (as of 2026-07-06)

| Thing | Value |
|---|---|
| Cluster | `eicr-cluster-production` (eu-west-2) |
| Backend service | `eicr-backend` — ECR repo `eicr-backend`, task-def family `eicr-backend`, 512 CPU / 2048 MB, port 3000, logs `/ecs/eicr/eicr-backend` |
| Web service | `eicr-pwa` — ECR repo **`eicr-frontend`** (repo name ≠ service name), task-def family `eicr-pwa`, 256 CPU / 512 MB, port 3000, logs `/ecs/eicr/eicr-pwa` |
| Legacy service | `eicr-frontend` (old Streamlit UI) still exists on the cluster, desired-count 0. NOT the PWA. Ignore it. |
| Domains | https://certmate.uk → `eicr-pwa`; https://api.certmate.uk → `eicr-backend`. ALB priority-10 rule forwards `/api/*` to the backend target group (`infrastructure/setup-domain.sh:394-406`) — this is why the web STT kill-switch endpoint lives at top-level `/runtime-config`, NOT `/api/runtime-config`. |
| Image tags | Every deploy pushes `:$GITHUB_SHA` + `:latest`. Task defs pin `:latest`. |
| Staging | Job `deploy-staging` exists (develop-branch push or manual dispatch with `environment=staging`; images tagged `staging-<sha>`/`staging-latest`, web built with `NEXT_PUBLIC_API_URL=https://staging.certmate.uk`) but **no `eicr-staging-*` ECS services exist** (verified live 2026-07-06) — the job pushes images to ECR and prints a warning, deploying nothing. `develop` branch is dead (last commit 2026-04-09). Treat staging as dormant. |

## 2. CI pipeline anatomy — `.github/workflows/deploy.yml` (single file, ~772 lines)

Triggers: push to `main`/`master`/`develop`; PR to `main`/`master`; `workflow_dispatch`. Full both-sides deploy ≈ 30 min; backend-only skips the ~17 min frontend Docker build.

Manual dispatch (overrides path detection; note: dispatch **skips the test jobs entirely** — `test-backend`/`test-frontend` have `if: github.event_name != 'workflow_dispatch'`):
```bash
gh workflow run deploy.yml -f deploy_target=backend  -f environment=production
gh workflow run deploy.yml -f deploy_target=frontend -f environment=production
gh workflow run deploy.yml -f deploy_target=both     -f environment=production
gh workflow run deploy.yml -f deploy_target=frontend-taskdef -f environment=production   # kill-switch fast path
```

### 2a. `detect-changes` — computes `target = backend | frontend | both | frontend-taskdef | none`

Path filters (dorny/paths-filter@v3), exactly as in the workflow:

| Target | Trigger paths |
|---|---|
| `backend` | `src/**`, `config/**`, `scripts/**`, `docker/backend.Dockerfile`, `ecs/task-def-backend.json` |
| `frontend` | `web/**`, `docker/nextjs.Dockerfile`, `ecs/task-def-frontend.json` |
| `both` | `package.json`, `package-lock.json`, `.github/workflows/deploy.yml` match BOTH filters; also the defensive fallback when nothing matches (e.g. README-only push still deploys both) |
| `frontend-taskdef` | The changed-file set is **EXACTLY one file: `ecs/task-def-frontend.json`** (checked via `list-files: json` + count==1). Any second changed file in the same push falls through to the normal `frontend`/`both` rebuild path. |

**`frontend-taskdef` fast path (~3-5 min):** skips both Docker builds and both test jobs' image gates, re-registers `ecs/task-def-frontend.json` against the EXISTING `:latest` image, rolls `eicr-pwa` only, waits stable. Purpose-built for flipping the `DEEPGRAM_STT_MODEL` runtime kill-switch (§4a). On `workflow_dispatch` the user-supplied `deploy_target` wins over path detection.

### 2b. What blocks vs what is advisory

| Job / step | Blocking? |
|---|---|
| `test-backend` — `npm ci`, `node --check src/*.js`, `npm test -- --coverage --ci` (Jest) | **BLOCKS** build-images |
| `test-frontend` — `npm run build` (webpack) and `npx vitest run` | **BLOCKS** build-images |
| `test-frontend` — `eslint --max-warnings=0` and `tsc --noEmit` | **Advisory** (`|| true`). Lint/typecheck failures do NOT stop a deploy — don't assume CI caught them. |
| `security-audit` — `npm audit --audit-level=high` (root + web) | **Advisory** (`|| true`) |
| `parity-ledger-warn` — stale parity-ledger rows | **Advisory**, PR-only, `continue-on-error: true`, nothing `needs:` it |
| `build-images` (ubuntu-24.04-arm) — Trivy scan **CRITICAL severity** (`ignore-unfixed: true`) | **BLOCKS** (exit-code 1). Trivy HIGH scan is advisory. |
| `deploy` — drift checks, migrations task, `wait services-stable` | **BLOCKS** (any step failure halts the deploy) |

Frontend image build-args baked at `next build` time (any `NEXT_PUBLIC_*` var must be declared ARG+ENV in `docker/nextjs.Dockerfile` or it is silently dropped): `NEXT_PUBLIC_API_URL=https://api.certmate.uk`, `NEXT_PUBLIC_REGEX_HINTS_ENABLED=1`, `NEXT_PUBLIC_RECORDING_RECONNECT_ENABLED=true`, `NEXT_PUBLIC_SILERO_VAD=0`.

### 2c. `deploy` job step order (production; `main` push or dispatch)

1. ECR login; build + push images for the in-scope side(s) (`:sha` + `:latest`). Skipped entirely for `frontend-taskdef`.
2. **`scripts/check-task-def-env-drift.sh <service> <template>`** per side — fails the deploy if any env var exists on the LIVE task def but not in the source template (i.e. an out-of-band hotfix that re-registering would silently strip). Bypass: `[skip-drift-check]` in the commit message (emergency only, must be followed by a source commit).
3. **`scripts/audit-env-var-source.sh ecs/task-def-backend.json`** (backend only) — the opposite direction: fails if backend code references an env var missing from both the template and the script's allowlist.
4. `aws ecs register-task-definition --cli-input-json file://ecs/task-def-*.json` per side.
5. **DB migrations one-off Fargate task** (backend deploys only): runs the JUST-registered backend task def with command override `node scripts/migrate-from-secrets.js` (node-pg-migrate up, DB creds from Secrets Manager), same subnets/SG as the live service, then `aws ecs wait tasks-stopped` and checks the container exit code. **Non-zero exit halts the deploy — old code keeps serving against the old schema** (the right side to fail to). Why it exists: before 2026-05-29 migrations weren't in CI; migrations 010/011 sat un-applied in prod → every attestation request 500'd ("failed to record attestations" on iOS).
6. `aws ecs update-service --force-new-deployment` with the new task-def ARN, per side.
7. `aws ecs wait services-stable` per rolled service (frontend-taskdef waits on `eicr-pwa` only).

## 3. Monitor a deploy / check production

```bash
# CI run status (single long-poll — see golden rule 3)
gh run list --limit 5
gh run watch <run-id> --exit-status

# ECS service status
aws ecs describe-services --cluster eicr-cluster-production --services eicr-pwa eicr-backend \
  --region eu-west-2 \
  --query "services[*].{Service:serviceName,Running:runningCount,Status:deployments[0].rolloutState}" \
  --output table

# Logs (CloudWatch)
aws logs tail /ecs/eicr/eicr-backend --region eu-west-2 --since 10m          # backend
aws logs tail /ecs/eicr/eicr-pwa     --region eu-west-2 --since 10m          # web
aws logs tail /ecs/eicr/eicr-backend --region eu-west-2 --follow             # live tail
aws logs tail /ecs/eicr/eicr-pwa --region eu-west-2 --since 10m --filter-pattern "JWT_SECRET"  # login-bounce triage

# OOM check on a stopped backend task (exit code 137 = container killed)
aws ecs describe-tasks --cluster eicr-cluster-production --region eu-west-2 \
  --tasks $(aws ecs list-tasks --cluster eicr-cluster-production --service-name eicr-backend \
    --desired-status STOPPED --region eu-west-2 --query 'taskArns[0]' --output text) \
  --query 'tasks[0].containers[0].{ExitCode:exitCode,Reason:reason}'
```

### Health endpoints (backend, `src/api.js`)

| Endpoint | What it tells you |
|---|---|
| `GET /health` and `GET /api/health` | Liveness only — Express is up; reports `storage: s3|local`. |
| `GET /api/health/ready` | **Readiness with per-check booleans** `{ status: 'ready'|'degraded', checks: { database, deepgram_key, anthropic_key } }` — 200 when all true, 503 otherwise. Checks DB `SELECT 1` + both API keys resolvable from Secrets Manager. Use this after a deploy/secret rotation; a bare `/health` 200 does NOT mean recordings can start. |
| `GET /api/docs` | Swagger UI for the REST API (`docs/api/openapi.yaml`). NOTE: the `/api/sonnet-stream` WebSocket voice protocol is NOT in this spec — see `certmate-voice-wire-protocol`. |

```bash
curl -s https://api.certmate.uk/api/health/ready | jq .
# PWA login-path smoke (expect 307 → /login?redirect=%2Fdashboard when unauthenticated)
curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" https://certmate.uk/dashboard
```

## 4. Rollback recipes

### 4a. STT kill-switch flip (config rollback, ~3-5 min) — the canonical fast path

`DEEPGRAM_STT_MODEL` in `ecs/task-def-frontend.json` selects the web speech-to-text model per recording session (`flux` is the current prod value; `nova3` is the fail-safe). Full mechanics — the `DEFAULT_STT_MODEL`/`SAFE_STT_MODEL` fail-safe split, the `/runtime-config`-not-`/api/*` ALB rationale, SW pin, auth note — live in **certmate-config-and-flags §5b** (one home; don't restate them here). This section owns only the flip recipe:

```bash
# 1. Edit ecs/task-def-frontend.json — change ONLY the DEEPGRAM_STT_MODEL value ("flux" <-> "nova3").
# 2. Commit + push to main. The changed-file set MUST be exactly that one file
#    to hit the frontend-taskdef fast path (no Docker rebuild):
git add ecs/task-def-frontend.json
git commit -m "fix(ecs): flip DEEPGRAM_STT_MODEL to nova3 — <why>"
git push origin main
gh run watch $(gh run list --limit 1 --json databaseId -q '.[0].databaseId') --exit-status
# 3. Verify (authenticated session): the PWA fetches /runtime-config per recording session.
```
If you bundle any other file into the commit, CI falls back to a full frontend rebuild (~30 min) — still correct, just slow.

### 4b. Code rollback via CI (canonical)

```bash
git revert <bad-commit>            # or a range; keep one concern per revert commit
git push origin main
gh run watch <run-id> --exit-status
```
Path-aware skip applies: a backend-only revert skips the frontend build. Backend deploys re-run migrations (idempotent `node-pg-migrate up`), but **reverting a commit does NOT undo an already-applied schema migration** — if the bad commit included a migration, write a follow-up down-migration; don't assume revert restores the schema.

### 4c. Emergency image rollback (out-of-band STOPGAP — must be followed by a source commit)

Task defs pin `:latest`, so re-point `:latest` at a known-good `:$SHA` image and roll:
```bash
SHA=<known-good-commit-sha>; REPO=eicr-backend        # or eicr-frontend for the PWA
MANIFEST=$(aws ecr batch-get-image --repository-name $REPO --image-ids imageTag=$SHA \
  --region eu-west-2 --query 'images[0].imageManifest' --output text)
aws ecr put-image --repository-name $REPO --image-tag latest --image-manifest "$MANIFEST" --region eu-west-2
aws ecs update-service --cluster eicr-cluster-production \
  --service eicr-backend --force-new-deployment --region eu-west-2   # eicr-pwa for frontend
aws ecs wait services-stable --cluster eicr-cluster-production --services eicr-backend --region eu-west-2
```
This is exactly the class of live-only change the drift doctrine exists for: the next `main` push re-tags `:latest` to the new build and your rollback evaporates. **Land the git revert (4b) in the same session.** (Command sequence is standard ECR retagging — UNVERIFIED against a live run in this repo; the canonical path is 4b.)

## 5. Auto-push policy (end of work session)

From CLAUDE.md — default is to push, the exclusions are the only reasons to hold:

**DO auto-push to `origin/main`** when backend changes are committed locally on `main` (or a merged feature branch) and `npm test` is green — do not wait to be asked. CI handles deploy.

**Do NOT auto-push when:**
- `npm test` failing — fix first, never ship red.
- Work is on a feature branch awaiting PR/review.
- A pre-push hook fails (secrets scan, full test suite — `.husky/pre-push` runs BOTH backend Jest and `npm test --workspace=web`) — investigate; never bypass with `--no-verify`.
- The user explicitly said "don't push" for this task.
- Schema/migration changes needing iOS coordination — push backend FIRST, `gh run watch` to ECS-rollout green, THEN start the iOS TestFlight cycle so iOS lands on a backend that already speaks the new shape.

## 6. Secrets Manager layout

| Secret ID | Contents | Consumed by |
|---|---|---|
| `eicr/api-keys` | ONE JSON object: `ANTHROPIC_API_KEY`, `DEEPGRAM_API_KEY`, `OPENAI_API_KEY`, `JWT_SECRET`, etc. | Backend at RUNTIME via `src/services/secrets.js` (task role `eicr-ecs-task-role`; `USE_AWS_SECRETS=true` in prod). PWA gets `JWT_SECRET` via the task-def `secrets` block (ECS injection at container start, execution role `eicr-ecs-execution-role`). |
| `eicr/database` | JSON: `host`, `username`, `password`, `dbname` → backend constructs `DATABASE_URL` | Backend runtime + the CI migrations task (`scripts/migrate-from-secrets.js`) |

**Trap (bit prod twice):** any NEW secret the PWA needs requires BOTH (a) an entry in `ecs/task-def-frontend.json` `secrets` block AND (b) `secretsmanager:GetSecretValue` on that exact ARN in the execution role's inline policy `eicr-exec-secrets-access`. Missing either → silent login bounce (middleware fail-closes; POST login succeeds, nav bounces back to `/login`). Triage: the `--filter-pattern "JWT_SECRET"` log tail in §3. No local `.env` is needed for cloud; local dev uses `.env` with `USE_AWS_SECRETS=false` (see `certmate-build-and-env`).

## 7. S3 conventions (bucket `eicr-files-production`)

| Prefix | Contents | Written by |
|---|---|---|
| `jobs/{userId}/{jobAddress}/output/` | `extracted_data.json`, `test_results.csv`, `installation_details.json`, `board_details.json`, `supply_characteristics.json`, `observations.json` | job save paths (`src/routes/recording.js`) |
| `session-analytics/{userId}/{sessionId}/` | `debug_log.jsonl` (NDJSON per-event debug log — the primary field-session forensics artifact), `field_sources.json`, `manifest.json`, `job_snapshot.json` | client upload via `POST /api/session/:sessionId/analytics` at session end |
| `debug/{userId}/{sessionId}/` | debug audio captures (when `ENABLE_DEBUG_AUDIO` on) | recording pipeline |

```bash
aws s3 ls s3://eicr-files-production/session-analytics/ --recursive | tail -20   # find recent sessions
aws s3 cp s3://eicr-files-production/session-analytics/<userId>/<sessionId>/debug_log.jsonl /tmp/
```
Interpreting `debug_log.jsonl` / running `scripts/analyze-session.js` over it: see `certmate-diagnostics-and-tooling`.

## 8. iOS TestFlight (pointer only)

Full runbook: `docs/reference/deploy-testflight.md` + `CertMateUnified/CLAUDE.md` § TestFlight Deployment. Script: `CertMateUnified/deploy-testflight.sh` (CertMateUnified is a SEPARATE nested git repo).

**Upload-is-not-release trap:** an App Store Connect upload that reaches `VALID` is still INVISIBLE to testers until the build is (a) added to the external TestFlight group and (b) submitted for beta review. Raw `altool`/upload-only flows do neither — builds have sat VALID-but-invisible. The repo script does all three (polls to VALID → adds group → submits for review); use it, not a manual upload. TestFlight uploads take 15-45 min — never run the script under a 10-min tool timeout; run detached and monitor the log.

## 9. Known-stale docs — do not follow blindly

| Doc | Status (2026-07-06) |
|---|---|
| `docs/reference/deployment.md` | Mixed: Node-20 and parity-ledger sections current; but "Deploy Changes to Cloud" section describes the RETIRED Streamlit-era manual-docker flow and the old `certomatic3000.co.uk` domain. The status/log commands are fine. |
| `docs/reference/deploy-runbook.md` | Secrets/IAM pre-flight checks (§ Pre-flight) are current and load-bearing; the manual "Deploy Steps" (local docker build/tag/push, `EICR_App/` cwd, ECR repo `eicr-pwa`) contradict CI-only doctrine and the real ECR repo name (`eicr-frontend`). Use for secrets reference only. |
| `docs/DEVELOPER_SETUP.md` | STALE (references a non-existent `frontend/` workspace). See `certmate-build-and-env`. |

## When NOT to use this skill

| You actually need | Go to |
|---|---|
| Local install, Node 20 pin, dev servers, Docker gotchas | `certmate-build-and-env` |
| Env-var/flag catalog, what each config axis does, how to add a var | `certmate-config-and-flags` |
| Interpreting debug_log.jsonl, latency benches, cost tracker, CloudWatch forensics | `certmate-diagnostics-and-tooling` |
| Test suites, what CI evidence means, parity-ledger mechanics | `certmate-validation-and-qa` |
| WHY the deploy/change rules exist (incidents, MANDATORY blocks, commit style) | `certmate-change-control` |
| Triage of a specific production symptom | `certmate-debugging-playbook` |
| The `/api/sonnet-stream` WebSocket protocol | `certmate-voice-wire-protocol` |

## Provenance and maintenance

Every fact above was read from the repo (or live AWS, where noted) on 2026-07-06. Re-verify drift-prone facts with:

| Fact | One-line re-verification |
|---|---|
| detect-changes filters + frontend-taskdef exact-file rule | `sed -n 71,153p .github/workflows/deploy.yml` |
| Blocking vs advisory steps (lint/tsc `\|\| true`, Trivy exit-code 1 CRITICAL) | `grep -n '|| true\|exit-code\|severity' .github/workflows/deploy.yml` |
| Migrations one-off task mechanics + halt-on-failure | `sed -n 654,731p .github/workflows/deploy.yml` |
| Frontend build-args (NEXT_PUBLIC_*) | `sed -n 551,571p .github/workflows/deploy.yml` |
| Current `DEEPGRAM_STT_MODEL` prod value | `grep DEEPGRAM_STT_MODEL ecs/task-def-frontend.json` |
| Kill-switch client resolution (nova3 fail-safe) | `grep -n 'DEFAULT_STT_MODEL\|SAFE_STT_MODEL' web/src/lib/runtime-config.ts` |
| `/runtime-config` route + SW never-cache pin | `grep -n runtime-config web/src/app/sw.ts web/src/app/runtime-config/route.ts` |
| Health endpoints incl. per-check booleans | `grep -n "app.get('/\(api/\)\?health" src/api.js && sed -n 199,226p src/api.js` |
| Secrets layout (`eicr/api-keys`, `eicr/database`) | `sed -n 1,40p src/services/secrets.js` |
| S3 bucket + prefixes | `grep S3_BUCKET ecs/task-def-backend.json && grep -n 's3Prefix' src/routes/recording.js` |
| Services/CPU/memory/ECR image refs | `grep -n '"family"\|"cpu"\|"memory"\|"image"' ecs/task-def-*.json` |
| Staging services still absent | `aws ecs list-services --cluster eicr-cluster-production --region eu-west-2` |
| Auto-push policy + exclusions | `grep -n "auto-push" CLAUDE.md` |
| TestFlight script steps (group attach + beta review) | `sed -n 1,32p docs/reference/deploy-testflight.md` |
