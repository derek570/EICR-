> Last updated: 2026-02-18
> Related: [Architecture](architecture.md) | [iOS Pipeline](ios-pipeline.md) | [Field Reference](field-reference.md) | [File Structure](file-structure.md) | [Deployment History](deployment-history.md)
> Hub: [../../CLAUDE.md](../../CLAUDE.md)

# Deployment & Troubleshooting

## Local Node version (match CI)

**Use Node 20 for local work.** CI pins Node 20 (`.github/workflows/deploy.yml` `node-version: '20'`, 4 sites); the repo-root `.nvmrc` = `20` records that pin for nvm users (`nvm use` at the repo root). The `web` workspace also declares `"engines": { "node": ">=20 <21" }` and a WARN-level preflight (`web/scripts/check-node.mjs`, wired as `pretest`) that fires on every `npm test --workspace=web` and in `.husky/pre-push`.

Why it matters: jsdom / Storage / experimental-webstorage behaviour differs across Node majors. Running the web vitest suite on a different major (e.g. v25) can pass locally while failing on CI's Node 20 — this is exactly what bit WS7 (the conditional `localStorage` shim in `web/tests/setup.ts`). The preflight is **warn-only** (exits 0) so it never blocks unrelated work or a GUI-git push; set `CHECK_NODE_STRICT=1` to make a mismatched major hard-fail. For an exact-patch pin, bump `.nvmrc` and `deploy.yml` to the same `20.x.y` in one commit.

## Deploy Changes to Cloud

The production site runs at **https://certomatic3000.co.uk**

**Workflow:**
1. Edit code locally (using Claude Code or any editor)
2. Test locally if needed: `streamlit run python/eicr_editor.py -- --user Derek`
3. Deploy to cloud:

### Deploy Frontend (Streamlit UI)
```bash
docker build -f Dockerfile.frontend -t eicr-frontend .
aws ecr get-login-password --region eu-west-2 | docker login --username AWS --password-stdin 196390795898.dkr.ecr.eu-west-2.amazonaws.com
docker tag eicr-frontend:latest 196390795898.dkr.ecr.eu-west-2.amazonaws.com/eicr-frontend:latest
docker push 196390795898.dkr.ecr.eu-west-2.amazonaws.com/eicr-frontend:latest
aws ecs update-service --cluster eicr-cluster-production --service eicr-frontend --force-new-deployment --region eu-west-2
```

### Deploy Backend (Job Processing)
```bash
docker build -f Dockerfile.backend -t eicr-backend .
aws ecr get-login-password --region eu-west-2 | docker login --username AWS --password-stdin 196390795898.dkr.ecr.eu-west-2.amazonaws.com
docker tag eicr-backend:latest 196390795898.dkr.ecr.eu-west-2.amazonaws.com/eicr-backend:latest
docker push 196390795898.dkr.ecr.eu-west-2.amazonaws.com/eicr-backend:latest
aws ecs update-service --cluster eicr-cluster-production --service eicr-backend --force-new-deployment --region eu-west-2
```

Changes go live in ~2 minutes.

**Or just tell Claude Code:** "deploy" or "push to cloud"

### Check Cloud Status
```bash
# Service status (both frontend and backend)
aws ecs describe-services --cluster eicr-cluster-production --services eicr-frontend eicr-backend --region eu-west-2 --query "services[*].{Service:serviceName,Running:runningCount,Status:deployments[0].rolloutState}" --output table

# View frontend logs
aws logs tail /ecs/eicr/eicr-frontend --region eu-west-2 --since 10m

# View backend logs (job processing)
aws logs tail /ecs/eicr/eicr-backend --region eu-west-2 --since 10m
```

### Parity-ledger staleness warning (PR-only, warn-only)

`.github/workflows/deploy.yml` job `parity-ledger-warn` (added 2026-07-02, WS1 of the iOS↔Web Full-Parity Program):

- Runs ONLY on `pull_request` events (`if: github.event_name == 'pull_request'` — on push/dispatch `github.base_ref` is empty and the diff would error-annotate every deploy run).
- Computes the PR's touched files (`git diff --name-only origin/${{ github.base_ref }}...HEAD`, checkout with `fetch-depth: 0`) and runs `node scripts/check-parity-ledger.mjs --ledger web/docs/parity-ledger.md --map web/docs/parity-ledger-files.json --changed-files …`.
- Emits GitHub `::warning::` annotations when a touched file maps (via `web/docs/parity-ledger-files.json`) to ledger rows whose `last-verified` is blank, invalid, or >30 days old. Blank-dated rows collapse into ONE summary line; a map id missing from the ledger and duplicate ledger ids also warn.
- **Never blocks anything:** the script always exits 0, the job has `continue-on-error: true`, and no other job `needs:` it. Touched files with no map entry are silently ignored by design.
- To silence a warning properly: re-verify the row against current iOS source and update its `last-verified` date in `web/docs/parity-ledger.md`.

### Field-replay corpus gate (accident-class; blocking; 2026-07-17)

The field-replay correctness gate replays real captured field sessions through the real `runShadowHarness` so a fix must pass its captured transcript before merging — full detail in [field-replay-corpus.md](field-replay-corpus.md).

- **Blocking (per-PR):** `npm run replay:field-corpus` runs as a step INSIDE `Test Backend (Node.js)` (so it rides the merge-blocking required check). This is the WHOLE blocking gate: each `expected_red` fixture must fail with exactly its target id, each `required_green` must pass. `test-backend` checks out `fetch-depth: 0` on the pinned Node `20.20.2`. An empty corpus exits 0. A `manual-deploy-gate` job closes the old `workflow_dispatch` bypass: a production dispatch requires `refs/heads/main` and runs the corpus before `build-images`.
- **Local backstop:** `.husky/pre-push` runs `replay:field-corpus:prepush` (XPASS-tolerant, fail-closed on any unexplained failure). Node-20 CI is authoritative.
- **Deferred (`field-replay-hardening-followups`):** signed-commit governance, trusted-run evidence + `ci-history-checks` history closure, the nightly live lane (`ANTHROPIC_API_KEY` + protected environment), and the per-fixture signed attestation are the malice-hardening the threat model defers; they were built in the original foundation and removed from the shipping gate.
- **Delivery is PR-only** — the hub auto-push rule is auto-PR-then-`gh pr merge` (Derek, 2026-07-16).

## Deployment State (Jan 2026)

- PWA Frontend: `eicr-pwa` service running on ECS Fargate
- Backend: `eicr-backend` service running on ECS Fargate
- Streamlit: Stopped (can re-enable via `aws ecs update-service --service eicr-frontend --desired-count 1`)

---

## Debug Job Processing Issues

If "Upload & Process Job" fails, check the backend logs in a new terminal:
```bash
# Watch backend logs in real-time (run in separate terminal)
aws logs tail /ecs/eicr/eicr-backend --region eu-west-2 --follow

# Check backend API health
curl https://certomatic3000.co.uk/api/health

# Check target group health
aws elbv2 describe-target-health --target-group-arn "arn:aws:elasticloadbalancing:eu-west-2:196390795898:targetgroup/eicr-tg-backend/be5fa4d15b55fc3d" --region eu-west-2 --query 'TargetHealthDescriptions[*].TargetHealth.State'

# Check for OOM (out of memory) kills
aws ecs describe-tasks --cluster eicr-cluster-production --tasks $(aws ecs list-tasks --cluster eicr-cluster-production --service-name eicr-backend --desired-status STOPPED --region eu-west-2 --query 'taskArns[0]' --output text) --region eu-west-2 --query 'tasks[0].containers[0].{ExitCode:exitCode,Reason:reason}'
```

## Common Issues & Solutions

| Error | Cause | Solution |
|-------|-------|----------|
| `Backend API error: Expecting value: line 1 column 1` | Empty response from backend | Check ALB timeout (should be 600s), check for OOM kills |
| `ENOENT: no such file or directory, scandir .../output` | Output folder was renamed | Fixed in `api.js` - uses `result.finalOutDir` |
| `OutOfMemoryError: Container killed` (exit code 137) | Backend needs more RAM | Task definition uses 2048MB memory |
| Job stuck on "Transcribing audio" | Gemini API hanging/overloaded | Restart backend: `aws ecs update-service --cluster eicr-cluster-production --service eicr-backend --force-new-deployment --region eu-west-2` |
| Job stuck on "processing" in dashboard | Dashboard doesn't auto-poll | Fixed: Dashboard now polls every 5s when jobs are processing |
| Job data empty in PWA editor | API expects `extracted_data.json` but pipeline creates separate files | Fixed: API now reads from individual files as fallback |
| PWA container health check failing | Alpine image missing wget | Fixed: Removed container health check, using ALB health check only (task def revision 6+) |
| ECS not pulling new Docker image | Task definition caches image digest | Force new task definition: `aws ecs register-task-definition` then update service |
| Jobs not appearing in dropdown | Frontend not reading from S3 | `get_output_directories()` and `load_job_file()` now use S3 in cloud mode |
| Circuit data empty/missing after load | CSV not loading from S3 | Fixed: `load_job_csv()` function added with S3 support |
| Circuit values misaligned in editor | CSV column names don't match editor | Fixed: `map_circuit_columns()` maps CSV→editor column names |
| `KeyError: circuit_designation not in index` | Missing required columns | Fixed: Editor now creates missing columns with defaults |
| PDF generation fails with path error | Trying to write to local path in cloud | Fixed: Uses temp file in cloud mode, uploads to S3 |
| Job appears with timestamp ID not address | S3 key used job ID instead of address | Fixed: `api.js` now uses `result.address` for S3 folder name |
| `Failed to fetch` on login | Backend DATABASE_URL not set | Fixed: `secrets.js` now loads `eicr/database` secret and constructs DATABASE_URL |
| `Failed to fetch` - PWA calls localhost | `.env.local` copied into Docker image overrides env var | Fixed: `Dockerfile.pwa` removes `.env.local` before build |
| PWA 503 / health check failing | `wget --spider` doesn't follow redirects, `/` redirects to `/login` | Fixed: Health check now uses `wget -O /dev/null http://localhost:3000/login` |
| Database secret JSON parse error | Password contains backslash escape | Fixed: Updated `eicr/database` secret with unescaped password |

## Bug Fix History

Historical bug fixes (January-February 2026) have been archived. See `docs/plans/archive/CLAUDE_FIX_HISTORY.md` for the complete history of all 28 fixes including:
- Duplicate job fixes, S3 path mismatches, data transformation fixes (Jan 2026)
- Linked observations, synchronized photo capture, security plugins (Jan 2026)
- CCU photo BS/EN extraction, job save duplicate/timestamp fixes (Feb 2026)
