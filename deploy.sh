#!/bin/bash
# Quick deploy CertMate frontend to ECS from Mac
# Skips GitHub Actions — builds locally, pushes to ECR, redeploys eicr-pwa
#
# Usage: ./deploy.sh [--backend]
#   No args  = frontend only (~2-3 min)
#   --backend = frontend + backend

set -euo pipefail

REGION="eu-west-2"
ACCOUNT="196390795898"
ECR_REGISTRY="${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com"
CLUSTER="eicr-cluster-production"
FRONTEND_REPO="eicr-frontend"
BACKEND_REPO="eicr-backend"
PWA_SERVICE="eicr-pwa"
BACKEND_SERVICE="eicr-backend"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

DEPLOY_BACKEND=false
if [[ "${1:-}" == "--backend" ]]; then
  DEPLOY_BACKEND=true
fi

echo "=== CertMate Quick Deploy ==="
echo "  Region:  $REGION"
echo "  Cluster: $CLUSTER"
echo "  Frontend: $DEPLOY_BACKEND && echo '+ backend' || echo 'only'"
echo ""

# 1. Login to ECR
echo "[1/4] Logging in to ECR..."
aws ecr get-login-password --region "$REGION" | \
  docker login --username AWS --password-stdin "$ECR_REGISTRY"

# 2. Build frontend (native ARM64 for Graviton ECS)
echo "[2/4] Building frontend image (linux/arm64)..."
docker build \
  --platform linux/arm64 \
  --no-cache \
  -f "$SCRIPT_DIR/docker/nextjs.Dockerfile" \
  --build-arg APP_DIR=frontend \
  --build-arg NEXT_PUBLIC_API_URL=https://certomatic3000.co.uk \
  -t "$ECR_REGISTRY/$FRONTEND_REPO:latest" \
  -t "$ECR_REGISTRY/$FRONTEND_REPO:local-$(git rev-parse --short HEAD)" \
  "$SCRIPT_DIR"

# 3. Push to ECR
echo "[3/4] Pushing frontend to ECR..."
docker push "$ECR_REGISTRY/$FRONTEND_REPO:latest"
docker push "$ECR_REGISTRY/$FRONTEND_REPO:local-$(git rev-parse --short HEAD)"

# 4. Backend (optional)
if $DEPLOY_BACKEND; then
  echo "[3b/4] Building backend image (linux/arm64)..."
  docker build \
    --platform linux/arm64 \
    -f "$SCRIPT_DIR/docker/backend.Dockerfile" \
    -t "$ECR_REGISTRY/$BACKEND_REPO:latest" \
    -t "$ECR_REGISTRY/$BACKEND_REPO:local-$(git rev-parse --short HEAD)" \
    "$SCRIPT_DIR"

  echo "[3c/4] Pushing backend to ECR..."
  docker push "$ECR_REGISTRY/$BACKEND_REPO:latest"
  docker push "$ECR_REGISTRY/$BACKEND_REPO:local-$(git rev-parse --short HEAD)"
fi

# 5. Register ARM64 task definitions and redeploy services
echo "[4/4] Registering ARM64 task definition for $PWA_SERVICE..."
FRONTEND_TASK_ARN=$(aws ecs register-task-definition \
  --region "$REGION" \
  --cli-input-json "file://$SCRIPT_DIR/ecs/task-def-frontend.json" \
  --query 'taskDefinition.taskDefinitionArn' \
  --output text)
echo "       Registered: $FRONTEND_TASK_ARN"

echo "       Deploying $PWA_SERVICE with new ARM64 task def..."
aws ecs update-service \
  --cluster "$CLUSTER" \
  --service "$PWA_SERVICE" \
  --task-definition "$FRONTEND_TASK_ARN" \
  --force-new-deployment \
  --region "$REGION" \
  --query 'service.serviceName' \
  --output text

if $DEPLOY_BACKEND; then
  echo "       Registering ARM64 task definition for $BACKEND_SERVICE..."
  BACKEND_TASK_ARN=$(aws ecs register-task-definition \
    --region "$REGION" \
    --cli-input-json "file://$SCRIPT_DIR/ecs/task-def-backend.json" \
    --query 'taskDefinition.taskDefinitionArn' \
    --output text)
  echo "       Registered: $BACKEND_TASK_ARN"

  echo "       Deploying $BACKEND_SERVICE with new ARM64 task def..."
  aws ecs update-service \
    --cluster "$CLUSTER" \
    --service "$BACKEND_SERVICE" \
    --task-definition "$BACKEND_TASK_ARN" \
    --force-new-deployment \
    --region "$REGION" \
    --query 'service.serviceName' \
    --output text
fi

echo ""
echo "=== Deploy triggered! ==="
echo "  Frontend image: $ECR_REGISTRY/$FRONTEND_REPO:latest"
echo "  Commit: $(git rev-parse --short HEAD)"
echo "  ECS will swap containers in ~2 min"
echo ""
echo "  Monitor: aws ecs describe-services --cluster $CLUSTER --service $PWA_SERVICE --region $REGION --query 'services[0].deployments[*].{status:status,running:runningCount,desired:desiredCount,rollout:rolloutState}'"
