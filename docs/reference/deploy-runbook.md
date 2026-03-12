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
Secrets are loaded at runtime by `src/secrets.js`.

| Secret ID | Contents |
|-----------|----------|
| `eicr/api-keys` | JSON: ANTHROPIC_API_KEY, DEEPGRAM_API_KEY, OPENAI_API_KEY, etc. |
| `eicr/database` | JSON: host, username, password, dbname |

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
