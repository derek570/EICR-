# CertMate (EICR-oMatic 3000) — AWS Deployment Runbook

> Quick reference for deploying to production on AWS ECS.

## Environment

| Resource | Value |
|----------|-------|
| AWS Region | eu-west-2 (London) |
| AWS Account | 196390795898 |
| ECS Cluster | eicr-cluster-production |
| Domain | certomatic3000.co.uk |
| ECR Frontend | 196390795898.dkr.ecr.eu-west-2.amazonaws.com/eicr-pwa |
| ECR Backend | 196390795898.dkr.ecr.eu-west-2.amazonaws.com/eicr-backend |
| ECS Service Frontend | eicr-pwa |
| ECS Service Backend | eicr-backend |

## AWS Secrets

The app uses AWS Secrets Manager — no .env file needed for cloud deploys.
Secrets are loaded two different ways depending on the container:

- **Backend** (`eicr-backend`) loads secrets at RUNTIME via Node.js
  (`src/secrets.js`) using the **task role** (`eicr-ecs-task-role`).
- **PWA** (`eicr-pwa`) loads secrets via ECS secrets-to-env injection
  at container start, which uses the **execution role**
  (`eicr-ecs-execution-role`). Any new secret the PWA needs must be
  added to BOTH the task def `secrets` block AND the execution role's
  inline policy `eicr-exec-secrets-access` (grants `secretsmanager:GetSecretValue`
  on the specific ARN — no wildcards).

| Secret ID | Contents |
|-----------|----------|
| `eicr/api-keys` | JSON: ANTHROPIC_API_KEY, DEEPGRAM_API_KEY, OPENAI_API_KEY, JWT_SECRET, etc. |
| `eicr/database` | JSON: host, username, password, dbname |

## Pre-flight checks (mandatory before a PWA cutover)

Required before pushing a rebuilt PWA to `main` — missing any of
these will cause a silent login loop (POST succeeds, middleware
bounces the authenticated nav back to `/login` with no error
message). Learned the hard way during the 2026-04-18 Phase 8
cutover; see the 2026-04-19 changelog entry in `CLAUDE.md`.

1. **PWA task def carries every env var the middleware reads.**
   Diff the `environment` + `secrets` blocks against
   `web/src/middleware.ts` — at minimum, `NODE_ENV` and `JWT_SECRET`.
   ```bash
   aws ecs describe-task-definition --task-definition eicr-pwa \
     --region eu-west-2 \
     --query 'taskDefinition.containerDefinitions[0].[environment,secrets]'
   ```
   `JWT_SECRET` MUST appear in `secrets` (not `environment`) and
   reference `eicr/api-keys:JWT_SECRET::`.

2. **Execution role has GetSecretValue on every referenced secret.**
   ```bash
   aws iam get-role-policy --role-name eicr-ecs-execution-role \
     --policy-name eicr-exec-secrets-access
   ```
   The policy's `Resource` list must include the ARN of every
   secret referenced in the PWA task def's `secrets` block.

3. **Smoke test after rollout — check that fail-closed is OFF.**
   ```bash
   curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" https://certmate.uk/dashboard
   ```
   Expected: `307 https://certmate.uk/login?redirect=%2Fdashboard`
   (the `?redirect=` query param is only set on the normal no-token
   path; fail-closed mode on `/` also redirects but the path for
   `/dashboard` looks identical, so this alone is not conclusive —
   also verify one real user can sign in end-to-end).

4. **Tail PWA logs for middleware warnings after the first deploy.**
   ```bash
   aws logs tail /ecs/eicr/eicr-pwa --region eu-west-2 --since 10m --filter-pattern "JWT_SECRET"
   ```
   Any hit means the secret isn't being injected.

## Deploy Steps

All commands run from `EICR_App/` directory.

### 1. Build Docker Images

```bash
# Frontend (PWA)
docker build --build-arg APP_DIR=frontend -f docker/nextjs.Dockerfile -t eicr-pwa .

# Backend
docker build -f docker/backend.Dockerfile -t eicr-backend .
```

### 2. Login to ECR

```bash
aws ecr get-login-password --region eu-west-2 | docker login --username AWS --password-stdin 196390795898.dkr.ecr.eu-west-2.amazonaws.com
```

### 3. Tag & Push

```bash
# Frontend
docker tag eicr-pwa:latest 196390795898.dkr.ecr.eu-west-2.amazonaws.com/eicr-pwa:latest
docker push 196390795898.dkr.ecr.eu-west-2.amazonaws.com/eicr-pwa:latest

# Backend
docker tag eicr-backend:latest 196390795898.dkr.ecr.eu-west-2.amazonaws.com/eicr-backend:latest
docker push 196390795898.dkr.ecr.eu-west-2.amazonaws.com/eicr-backend:latest
```

### 4. Deploy to ECS

```bash
# Frontend
aws ecs update-service --cluster eicr-cluster-production --service eicr-pwa --force-new-deployment --region eu-west-2

# Backend
aws ecs update-service --cluster eicr-cluster-production --service eicr-backend --force-new-deployment --region eu-west-2
```

### 5. Verify (~2 minutes)

```bash
aws ecs describe-services \
  --cluster eicr-cluster-production \
  --services eicr-pwa eicr-backend \
  --region eu-west-2 \
  --query "services[*].{Service:serviceName,Running:runningCount,Status:deployments[0].rolloutState}" \
  --output table
```

### 6. View Logs (if needed)

```bash
# Backend logs (last 10 minutes)
aws logs tail /ecs/eicr/eicr-backend --region eu-west-2 --since 10m

# Frontend logs
aws logs tail /ecs/eicr/eicr-pwa --region eu-west-2 --since 10m
```

## Managing Secrets

### Update API Keys

```bash
aws secretsmanager put-secret-value \
  --secret-id eicr/api-keys \
  --region eu-west-2 \
  --secret-string '{"ANTHROPIC_API_KEY":"...","DEEPGRAM_API_KEY":"...","OPENAI_API_KEY":"..."}'
```

### Update DB Credentials

```bash
aws secretsmanager put-secret-value \
  --secret-id eicr/database \
  --region eu-west-2 \
  --secret-string '{"host":"eicr-db-production.cfo684yymx9d.eu-west-2.rds.amazonaws.com","username":"eicr_admin","password":"...","dbname":"eicr_production"}'
```

> Changes go live in ~2 minutes after `force-new-deployment`.
