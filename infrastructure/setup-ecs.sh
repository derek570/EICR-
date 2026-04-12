#!/bin/bash
# ============================================
# EICR-oMatic 3000 - AWS ECS Fargate Setup
# Phase 3: Cloud Deployment
# ============================================

set -e

# Configuration
AWS_REGION="eu-west-2"
PROJECT_NAME="eicr"
ENVIRONMENT="production"

# ECS Configuration
CLUSTER_NAME="${PROJECT_NAME}-cluster-${ENVIRONMENT}"
FRONTEND_SERVICE="${PROJECT_NAME}-frontend"
BACKEND_SERVICE="${PROJECT_NAME}-backend"

# ECR Configuration
FRONTEND_REPO="${PROJECT_NAME}-frontend"
BACKEND_REPO="${PROJECT_NAME}-backend"

# ALB Configuration
ALB_NAME="${PROJECT_NAME}-alb-${ENVIRONMENT}"
TARGET_GROUP_FRONTEND="${PROJECT_NAME}-tg-frontend"
TARGET_GROUP_BACKEND="${PROJECT_NAME}-tg-backend"

# Container Configuration
FRONTEND_PORT=8501  # Streamlit default
BACKEND_PORT=3000   # Node.js

# Task Configuration
CPU="256"           # 0.25 vCPU
MEMORY="512"        # 512 MB

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo "============================================"
echo "  EICR-oMatic 3000 - ECS Fargate Setup"
echo "  Phase 3: Cloud Deployment"
echo "  Region: ${AWS_REGION}"
echo "============================================"
echo ""

# ============================================
# PRE-FLIGHT CHECKS
# ============================================
check_prerequisites() {
    echo -e "${YELLOW}Checking prerequisites...${NC}"

    # Check AWS CLI
    if ! command -v aws &> /dev/null; then
        echo -e "${RED}ERROR: AWS CLI is not installed.${NC}"
        echo "Install with: brew install awscli"
        exit 1
    fi

    if ! aws sts get-caller-identity &> /dev/null; then
        echo -e "${RED}ERROR: AWS CLI is not configured.${NC}"
        echo "Run: aws configure"
        exit 1
    fi

    ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
    echo -e "${GREEN}AWS CLI configured. Account: ${ACCOUNT_ID}${NC}"

    # Check Docker
    if ! command -v docker &> /dev/null; then
        echo -e "${RED}ERROR: Docker is not installed.${NC}"
        echo "Install Docker Desktop from https://docker.com"
        exit 1
    fi
    echo -e "${GREEN}Docker is installed.${NC}"

    echo ""
}

# ============================================
# ECR REPOSITORY SETUP
# ============================================
create_ecr_repositories() {
    echo -e "${BLUE}[1/7] Creating ECR Repositories...${NC}"

    for REPO in "${FRONTEND_REPO}" "${BACKEND_REPO}"; do
        if aws ecr describe-repositories --repository-names "${REPO}" --region "${AWS_REGION}" 2>/dev/null; then
            echo "  Repository ${REPO} already exists."
        else
            aws ecr create-repository \
                --repository-name "${REPO}" \
                --region "${AWS_REGION}" \
                --image-scanning-configuration scanOnPush=true
            echo -e "  ${GREEN}Created repository: ${REPO}${NC}"
        fi
    done

    # Get ECR login
    echo "  Logging into ECR..."
    aws ecr get-login-password --region "${AWS_REGION}" | \
        docker login --username AWS --password-stdin "${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

    echo -e "${GREEN}  ECR repositories ready.${NC}"
    echo ""
}

# ============================================
# VPC AND NETWORKING
# ============================================
setup_networking() {
    echo -e "${BLUE}[2/7] Setting up networking...${NC}"

    # Get default VPC
    VPC_ID=$(aws ec2 describe-vpcs \
        --filters "Name=isDefault,Values=true" \
        --query "Vpcs[0].VpcId" --output text \
        --region "${AWS_REGION}")

    if [ "$VPC_ID" == "None" ] || [ -z "$VPC_ID" ]; then
        echo -e "${RED}ERROR: No default VPC found.${NC}"
        exit 1
    fi
    echo "  VPC: ${VPC_ID}"

    # Get subnets (need at least 2 for ALB)
    SUBNET_IDS=$(aws ec2 describe-subnets \
        --filters "Name=vpc-id,Values=${VPC_ID}" \
        --query "Subnets[*].SubnetId" --output text \
        --region "${AWS_REGION}")

    SUBNET_ARRAY=($SUBNET_IDS)
    if [ ${#SUBNET_ARRAY[@]} -lt 2 ]; then
        echo -e "${RED}ERROR: Need at least 2 subnets for ALB.${NC}"
        exit 1
    fi
    echo "  Subnets: ${SUBNET_IDS}"

    # Create security group for ALB
    ALB_SG_NAME="${PROJECT_NAME}-alb-sg"
    ALB_SG_ID=$(aws ec2 describe-security-groups \
        --filters "Name=group-name,Values=${ALB_SG_NAME}" "Name=vpc-id,Values=${VPC_ID}" \
        --query "SecurityGroups[0].GroupId" --output text \
        --region "${AWS_REGION}" 2>/dev/null)

    if [ "$ALB_SG_ID" == "None" ] || [ -z "$ALB_SG_ID" ]; then
        ALB_SG_ID=$(aws ec2 create-security-group \
            --group-name "${ALB_SG_NAME}" \
            --description "Security group for EICR ALB" \
            --vpc-id "${VPC_ID}" \
            --region "${AWS_REGION}" \
            --query "GroupId" --output text)

        # Allow HTTP and HTTPS
        aws ec2 authorize-security-group-ingress \
            --group-id "${ALB_SG_ID}" \
            --protocol tcp --port 80 --cidr 0.0.0.0/0 \
            --region "${AWS_REGION}"

        aws ec2 authorize-security-group-ingress \
            --group-id "${ALB_SG_ID}" \
            --protocol tcp --port 443 --cidr 0.0.0.0/0 \
            --region "${AWS_REGION}"

        echo -e "  ${GREEN}Created ALB security group: ${ALB_SG_ID}${NC}"
    else
        echo "  ALB security group exists: ${ALB_SG_ID}"
    fi

    # Create security group for ECS tasks
    ECS_SG_NAME="${PROJECT_NAME}-ecs-sg"
    ECS_SG_ID=$(aws ec2 describe-security-groups \
        --filters "Name=group-name,Values=${ECS_SG_NAME}" "Name=vpc-id,Values=${VPC_ID}" \
        --query "SecurityGroups[0].GroupId" --output text \
        --region "${AWS_REGION}" 2>/dev/null)

    if [ "$ECS_SG_ID" == "None" ] || [ -z "$ECS_SG_ID" ]; then
        ECS_SG_ID=$(aws ec2 create-security-group \
            --group-name "${ECS_SG_NAME}" \
            --description "Security group for EICR ECS tasks" \
            --vpc-id "${VPC_ID}" \
            --region "${AWS_REGION}" \
            --query "GroupId" --output text)

        # Allow traffic from ALB
        aws ec2 authorize-security-group-ingress \
            --group-id "${ECS_SG_ID}" \
            --protocol tcp --port "${FRONTEND_PORT}" \
            --source-group "${ALB_SG_ID}" \
            --region "${AWS_REGION}"

        aws ec2 authorize-security-group-ingress \
            --group-id "${ECS_SG_ID}" \
            --protocol tcp --port "${BACKEND_PORT}" \
            --source-group "${ALB_SG_ID}" \
            --region "${AWS_REGION}"

        echo -e "  ${GREEN}Created ECS security group: ${ECS_SG_ID}${NC}"
    else
        echo "  ECS security group exists: ${ECS_SG_ID}"
    fi

    echo ""
}

# ============================================
# ECS CLUSTER
# ============================================
create_ecs_cluster() {
    echo -e "${BLUE}[3/7] Creating ECS Cluster...${NC}"

    if aws ecs describe-clusters --clusters "${CLUSTER_NAME}" --region "${AWS_REGION}" \
        --query "clusters[?status=='ACTIVE'].clusterName" --output text | grep -q "${CLUSTER_NAME}"; then
        echo "  Cluster already exists: ${CLUSTER_NAME}"
    else
        aws ecs create-cluster \
            --cluster-name "${CLUSTER_NAME}" \
            --capacity-providers FARGATE FARGATE_SPOT \
            --default-capacity-provider-strategy capacityProvider=FARGATE,weight=1 \
            --region "${AWS_REGION}"

        echo -e "  ${GREEN}Created cluster: ${CLUSTER_NAME}${NC}"
    fi

    echo ""
}

# ============================================
# IAM ROLES FOR ECS
# ============================================
create_iam_roles() {
    echo -e "${BLUE}[4/7] Creating IAM Roles...${NC}"

    # ECS Task Execution Role
    EXECUTION_ROLE_NAME="${PROJECT_NAME}-ecs-execution-role"

    if ! aws iam get-role --role-name "${EXECUTION_ROLE_NAME}" 2>/dev/null; then
        # Create trust policy
        TRUST_POLICY=$(cat <<EOF
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Principal": {
                "Service": "ecs-tasks.amazonaws.com"
            },
            "Action": "sts:AssumeRole"
        }
    ]
}
EOF
)
        aws iam create-role \
            --role-name "${EXECUTION_ROLE_NAME}" \
            --assume-role-policy-document "${TRUST_POLICY}"

        # Attach managed policy
        aws iam attach-role-policy \
            --role-name "${EXECUTION_ROLE_NAME}" \
            --policy-arn "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"

        # Add Secrets Manager access
        SECRETS_POLICY=$(cat <<EOF
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": [
                "secretsmanager:GetSecretValue"
            ],
            "Resource": "arn:aws:secretsmanager:${AWS_REGION}:${ACCOUNT_ID}:secret:${PROJECT_NAME}/*"
        }
    ]
}
EOF
)
        aws iam put-role-policy \
            --role-name "${EXECUTION_ROLE_NAME}" \
            --policy-name "SecretsAccess" \
            --policy-document "${SECRETS_POLICY}"

        echo -e "  ${GREEN}Created execution role: ${EXECUTION_ROLE_NAME}${NC}"
    else
        echo "  Execution role exists: ${EXECUTION_ROLE_NAME}"
    fi

    # ECS Task Role (for S3/RDS access from containers)
    TASK_ROLE_NAME="${PROJECT_NAME}-ecs-task-role"

    if ! aws iam get-role --role-name "${TASK_ROLE_NAME}" 2>/dev/null; then
        TRUST_POLICY=$(cat <<EOF
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Principal": {
                "Service": "ecs-tasks.amazonaws.com"
            },
            "Action": "sts:AssumeRole"
        }
    ]
}
EOF
)
        aws iam create-role \
            --role-name "${TASK_ROLE_NAME}" \
            --assume-role-policy-document "${TRUST_POLICY}"

        # S3 access policy
        S3_POLICY=$(cat <<EOF
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": [
                "s3:GetObject",
                "s3:PutObject",
                "s3:DeleteObject",
                "s3:ListBucket"
            ],
            "Resource": [
                "arn:aws:s3:::${PROJECT_NAME}-files-${ENVIRONMENT}",
                "arn:aws:s3:::${PROJECT_NAME}-files-${ENVIRONMENT}/*"
            ]
        },
        {
            "Effect": "Allow",
            "Action": [
                "secretsmanager:GetSecretValue"
            ],
            "Resource": "arn:aws:secretsmanager:${AWS_REGION}:${ACCOUNT_ID}:secret:${PROJECT_NAME}/*"
        }
    ]
}
EOF
)
        aws iam put-role-policy \
            --role-name "${TASK_ROLE_NAME}" \
            --policy-name "S3AndSecretsAccess" \
            --policy-document "${S3_POLICY}"

        echo -e "  ${GREEN}Created task role: ${TASK_ROLE_NAME}${NC}"
    else
        echo "  Task role exists: ${TASK_ROLE_NAME}"
    fi

    EXECUTION_ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${EXECUTION_ROLE_NAME}"
    TASK_ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${TASK_ROLE_NAME}"

    echo ""
}

# ============================================
# CLOUDWATCH LOG GROUPS
# ============================================
create_log_groups() {
    echo -e "${BLUE}[5/7] Creating CloudWatch Log Groups...${NC}"

    for SERVICE in "${FRONTEND_SERVICE}" "${BACKEND_SERVICE}"; do
        LOG_GROUP="/ecs/${PROJECT_NAME}/${SERVICE}"

        if aws logs describe-log-groups --log-group-name-prefix "${LOG_GROUP}" --region "${AWS_REGION}" \
            --query "logGroups[?logGroupName=='${LOG_GROUP}'].logGroupName" --output text | grep -q "${LOG_GROUP}"; then
            echo "  Log group exists: ${LOG_GROUP}"
        else
            aws logs create-log-group \
                --log-group-name "${LOG_GROUP}" \
                --region "${AWS_REGION}"

            # Set retention to 30 days
            aws logs put-retention-policy \
                --log-group-name "${LOG_GROUP}" \
                --retention-in-days 30 \
                --region "${AWS_REGION}"

            echo -e "  ${GREEN}Created log group: ${LOG_GROUP}${NC}"
        fi
    done

    echo ""
}

# ============================================
# APPLICATION LOAD BALANCER
# ============================================
create_alb() {
    echo -e "${BLUE}[6/7] Creating Application Load Balancer...${NC}"

    # Check if ALB exists
    ALB_ARN=$(aws elbv2 describe-load-balancers \
        --names "${ALB_NAME}" \
        --region "${AWS_REGION}" \
        --query "LoadBalancers[0].LoadBalancerArn" --output text 2>/dev/null || echo "")

    if [ -z "$ALB_ARN" ] || [ "$ALB_ARN" == "None" ]; then
        # Create ALB
        ALB_ARN=$(aws elbv2 create-load-balancer \
            --name "${ALB_NAME}" \
            --subnets ${SUBNET_IDS} \
            --security-groups "${ALB_SG_ID}" \
            --scheme internet-facing \
            --type application \
            --region "${AWS_REGION}" \
            --query "LoadBalancers[0].LoadBalancerArn" --output text)

        echo -e "  ${GREEN}Created ALB: ${ALB_NAME}${NC}"
    else
        echo "  ALB exists: ${ALB_NAME}"
    fi

    # Create frontend target group
    FRONTEND_TG_ARN=$(aws elbv2 describe-target-groups \
        --names "${TARGET_GROUP_FRONTEND}" \
        --region "${AWS_REGION}" \
        --query "TargetGroups[0].TargetGroupArn" --output text 2>/dev/null || echo "")

    if [ -z "$FRONTEND_TG_ARN" ] || [ "$FRONTEND_TG_ARN" == "None" ]; then
        FRONTEND_TG_ARN=$(aws elbv2 create-target-group \
            --name "${TARGET_GROUP_FRONTEND}" \
            --protocol HTTP \
            --port "${FRONTEND_PORT}" \
            --vpc-id "${VPC_ID}" \
            --target-type ip \
            --health-check-path "/_stcore/health" \
            --health-check-interval-seconds 30 \
            --health-check-timeout-seconds 5 \
            --healthy-threshold-count 2 \
            --unhealthy-threshold-count 3 \
            --region "${AWS_REGION}" \
            --query "TargetGroups[0].TargetGroupArn" --output text)

        echo -e "  ${GREEN}Created target group: ${TARGET_GROUP_FRONTEND}${NC}"
    else
        echo "  Target group exists: ${TARGET_GROUP_FRONTEND}"
    fi

    # Create backend target group
    BACKEND_TG_ARN=$(aws elbv2 describe-target-groups \
        --names "${TARGET_GROUP_BACKEND}" \
        --region "${AWS_REGION}" \
        --query "TargetGroups[0].TargetGroupArn" --output text 2>/dev/null || echo "")

    if [ -z "$BACKEND_TG_ARN" ] || [ "$BACKEND_TG_ARN" == "None" ]; then
        BACKEND_TG_ARN=$(aws elbv2 create-target-group \
            --name "${TARGET_GROUP_BACKEND}" \
            --protocol HTTP \
            --port "${BACKEND_PORT}" \
            --vpc-id "${VPC_ID}" \
            --target-type ip \
            --health-check-path "/health" \
            --health-check-interval-seconds 30 \
            --health-check-timeout-seconds 5 \
            --healthy-threshold-count 2 \
            --unhealthy-threshold-count 3 \
            --region "${AWS_REGION}" \
            --query "TargetGroups[0].TargetGroupArn" --output text)

        echo -e "  ${GREEN}Created target group: ${TARGET_GROUP_BACKEND}${NC}"
    else
        echo "  Target group exists: ${TARGET_GROUP_BACKEND}"
    fi

    # Create HTTP listener (redirect to HTTPS later when SSL is set up)
    LISTENER_ARN=$(aws elbv2 describe-listeners \
        --load-balancer-arn "${ALB_ARN}" \
        --region "${AWS_REGION}" \
        --query "Listeners[?Port==\`80\`].ListenerArn" --output text 2>/dev/null || echo "")

    if [ -z "$LISTENER_ARN" ] || [ "$LISTENER_ARN" == "None" ]; then
        LISTENER_ARN=$(aws elbv2 create-listener \
            --load-balancer-arn "${ALB_ARN}" \
            --protocol HTTP \
            --port 80 \
            --default-actions Type=forward,TargetGroupArn="${FRONTEND_TG_ARN}" \
            --region "${AWS_REGION}" \
            --query "Listeners[0].ListenerArn" --output text)

        echo -e "  ${GREEN}Created HTTP listener on port 80${NC}"
    else
        echo "  HTTP listener exists on port 80"
    fi

    # Add path-based routing rule for /api/* to backend
    EXISTING_RULES=$(aws elbv2 describe-rules \
        --listener-arn "${LISTENER_ARN}" \
        --region "${AWS_REGION}" \
        --query "Rules[?Conditions[?Field=='path-pattern' && Values[?contains(@, '/api/*')]]].RuleArn" --output text 2>/dev/null || echo "")

    if [ -z "$EXISTING_RULES" ] || [ "$EXISTING_RULES" == "None" ]; then
        aws elbv2 create-rule \
            --listener-arn "${LISTENER_ARN}" \
            --priority 10 \
            --conditions Field=path-pattern,Values='/api/*' \
            --actions Type=forward,TargetGroupArn="${BACKEND_TG_ARN}" \
            --region "${AWS_REGION}" > /dev/null

        echo -e "  ${GREEN}Created routing rule: /api/* -> backend${NC}"
    else
        echo "  Routing rule for /api/* already exists"
    fi

    # Get ALB DNS name
    ALB_DNS=$(aws elbv2 describe-load-balancers \
        --load-balancer-arns "${ALB_ARN}" \
        --region "${AWS_REGION}" \
        --query "LoadBalancers[0].DNSName" --output text)

    echo ""
    echo -e "  ${GREEN}ALB DNS: ${ALB_DNS}${NC}"
    echo ""
}

# ============================================
# ECS TASK DEFINITIONS
# ============================================
create_task_definitions() {
    echo -e "${BLUE}[7/7] Creating ECS Task Definitions...${NC}"

    # Frontend task definition
    FRONTEND_TASK_DEF=$(cat <<EOF
{
    "family": "${FRONTEND_SERVICE}",
    "networkMode": "awsvpc",
    "requiresCompatibilities": ["FARGATE"],
    "cpu": "${CPU}",
    "memory": "${MEMORY}",
    "executionRoleArn": "${EXECUTION_ROLE_ARN}",
    "taskRoleArn": "${TASK_ROLE_ARN}",
    "containerDefinitions": [
        {
            "name": "${FRONTEND_SERVICE}",
            "image": "${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${FRONTEND_REPO}:latest",
            "essential": true,
            "portMappings": [
                {
                    "containerPort": ${FRONTEND_PORT},
                    "protocol": "tcp"
                }
            ],
            "environment": [
                {"name": "AWS_REGION", "value": "${AWS_REGION}"},
                {"name": "USE_AWS_SECRETS", "value": "true"},
                {"name": "STORAGE_TYPE", "value": "s3"},
                {"name": "S3_BUCKET", "value": "${PROJECT_NAME}-files-${ENVIRONMENT}"},
                {"name": "DATABASE_TYPE", "value": "postgresql"},
                {"name": "BACKEND_URL", "value": "https://certmate.uk"}
            ],
            "logConfiguration": {
                "logDriver": "awslogs",
                "options": {
                    "awslogs-group": "/ecs/${PROJECT_NAME}/${FRONTEND_SERVICE}",
                    "awslogs-region": "${AWS_REGION}",
                    "awslogs-stream-prefix": "ecs"
                }
            }
        }
    ]
}
EOF
)

    echo "${FRONTEND_TASK_DEF}" > /tmp/frontend-task-def.json
    aws ecs register-task-definition \
        --cli-input-json file:///tmp/frontend-task-def.json \
        --region "${AWS_REGION}" > /dev/null

    echo -e "  ${GREEN}Registered task definition: ${FRONTEND_SERVICE}${NC}"

    # Backend task definition
    BACKEND_TASK_DEF=$(cat <<EOF
{
    "family": "${BACKEND_SERVICE}",
    "networkMode": "awsvpc",
    "requiresCompatibilities": ["FARGATE"],
    "cpu": "${CPU}",
    "memory": "${MEMORY}",
    "executionRoleArn": "${EXECUTION_ROLE_ARN}",
    "taskRoleArn": "${TASK_ROLE_ARN}",
    "containerDefinitions": [
        {
            "name": "${BACKEND_SERVICE}",
            "image": "${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${BACKEND_REPO}:latest",
            "essential": true,
            "portMappings": [
                {
                    "containerPort": ${BACKEND_PORT},
                    "protocol": "tcp"
                }
            ],
            "environment": [
                {"name": "AWS_REGION", "value": "${AWS_REGION}"},
                {"name": "USE_AWS_SECRETS", "value": "true"},
                {"name": "STORAGE_TYPE", "value": "s3"},
                {"name": "S3_BUCKET", "value": "${PROJECT_NAME}-files-${ENVIRONMENT}"},
                {"name": "DATABASE_TYPE", "value": "postgresql"},
                {"name": "NODE_ENV", "value": "production"},
                {"name": "PORT", "value": "3000"}
            ],
            "logConfiguration": {
                "logDriver": "awslogs",
                "options": {
                    "awslogs-group": "/ecs/${PROJECT_NAME}/${BACKEND_SERVICE}",
                    "awslogs-region": "${AWS_REGION}",
                    "awslogs-stream-prefix": "ecs"
                }
            }
        }
    ]
}
EOF
)

    echo "${BACKEND_TASK_DEF}" > /tmp/backend-task-def.json
    aws ecs register-task-definition \
        --cli-input-json file:///tmp/backend-task-def.json \
        --region "${AWS_REGION}" > /dev/null

    echo -e "  ${GREEN}Registered task definition: ${BACKEND_SERVICE}${NC}"

    # Clean up
    rm -f /tmp/frontend-task-def.json /tmp/backend-task-def.json

    echo ""
}

# ============================================
# CREATE ECS SERVICES
# ============================================
create_ecs_services() {
    echo -e "${BLUE}Creating ECS Services...${NC}"

    # Frontend service
    if aws ecs describe-services --cluster "${CLUSTER_NAME}" --services "${FRONTEND_SERVICE}" \
        --region "${AWS_REGION}" --query "services[?status=='ACTIVE'].serviceName" --output text 2>/dev/null | grep -q "${FRONTEND_SERVICE}"; then
        echo "  Frontend service already exists."
    else
        aws ecs create-service \
            --cluster "${CLUSTER_NAME}" \
            --service-name "${FRONTEND_SERVICE}" \
            --task-definition "${FRONTEND_SERVICE}" \
            --desired-count 1 \
            --launch-type FARGATE \
            --network-configuration "awsvpcConfiguration={subnets=[${SUBNET_ARRAY[0]},${SUBNET_ARRAY[1]}],securityGroups=[${ECS_SG_ID}],assignPublicIp=ENABLED}" \
            --load-balancers "targetGroupArn=${FRONTEND_TG_ARN},containerName=${FRONTEND_SERVICE},containerPort=${FRONTEND_PORT}" \
            --region "${AWS_REGION}" > /dev/null

        echo -e "  ${GREEN}Created frontend service${NC}"
    fi

    # Backend service
    if aws ecs describe-services --cluster "${CLUSTER_NAME}" --services "${BACKEND_SERVICE}" \
        --region "${AWS_REGION}" --query "services[?status=='ACTIVE'].serviceName" --output text 2>/dev/null | grep -q "${BACKEND_SERVICE}"; then
        echo "  Backend service already exists."
    else
        aws ecs create-service \
            --cluster "${CLUSTER_NAME}" \
            --service-name "${BACKEND_SERVICE}" \
            --task-definition "${BACKEND_SERVICE}" \
            --desired-count 1 \
            --launch-type FARGATE \
            --network-configuration "awsvpcConfiguration={subnets=[${SUBNET_ARRAY[0]},${SUBNET_ARRAY[1]}],securityGroups=[${ECS_SG_ID}],assignPublicIp=ENABLED}" \
            --region "${AWS_REGION}" > /dev/null

        echo -e "  ${GREEN}Created backend service${NC}"
    fi

    echo ""
}

# ============================================
# SSL CERTIFICATE INSTRUCTIONS
# ============================================
print_ssl_instructions() {
    echo ""
    echo "============================================"
    echo -e "${YELLOW}SSL Certificate Setup (Manual Step)${NC}"
    echo "============================================"
    echo ""
    echo "To enable HTTPS, you need a domain name and SSL certificate:"
    echo ""
    echo "1. Get a domain name (if you don't have one):"
    echo "   - AWS Route 53: ~\$12/year for .com"
    echo "   - Or use your existing domain registrar"
    echo ""
    echo "2. Request SSL certificate in AWS Certificate Manager:"
    echo "   aws acm request-certificate \\"
    echo "     --domain-name yourdomain.com \\"
    echo "     --validation-method DNS \\"
    echo "     --region ${AWS_REGION}"
    echo ""
    echo "3. Validate the certificate (add DNS records as instructed)"
    echo ""
    echo "4. Add HTTPS listener to ALB:"
    echo "   aws elbv2 create-listener \\"
    echo "     --load-balancer-arn ${ALB_ARN} \\"
    echo "     --protocol HTTPS \\"
    echo "     --port 443 \\"
    echo "     --certificates CertificateArn=<YOUR_CERT_ARN> \\"
    echo "     --default-actions Type=forward,TargetGroupArn=${FRONTEND_TG_ARN}"
    echo ""
}

# ============================================
# SUMMARY
# ============================================
print_summary() {
    echo ""
    echo "============================================"
    echo -e "${GREEN}ECS Fargate Setup Complete!${NC}"
    echo "============================================"
    echo ""
    echo "Resources created:"
    echo "  - ECR Repositories: ${FRONTEND_REPO}, ${BACKEND_REPO}"
    echo "  - ECS Cluster: ${CLUSTER_NAME}"
    echo "  - Application Load Balancer: ${ALB_NAME}"
    echo "  - Target Groups: ${TARGET_GROUP_FRONTEND}, ${TARGET_GROUP_BACKEND}"
    echo "  - CloudWatch Log Groups"
    echo "  - IAM Roles for ECS tasks"
    echo ""
    echo "============================================"
    echo "  Application URL"
    echo "============================================"
    echo ""
    echo -e "  ${GREEN}http://${ALB_DNS}${NC}"
    echo ""
    echo "  (Note: Services won't work until you push Docker images)"
    echo ""
    echo "============================================"
    echo "  Next Steps"
    echo "============================================"
    echo ""
    echo "1. Build and push Docker images:"
    echo ""
    echo "   # Frontend (Streamlit)"
    echo "   docker build -f Dockerfile.frontend -t ${FRONTEND_REPO} ."
    echo "   docker tag ${FRONTEND_REPO}:latest ${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${FRONTEND_REPO}:latest"
    echo "   docker push ${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${FRONTEND_REPO}:latest"
    echo ""
    echo "   # Backend (Node.js)"
    echo "   docker build -f Dockerfile.backend -t ${BACKEND_REPO} ."
    echo "   docker tag ${BACKEND_REPO}:latest ${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${BACKEND_REPO}:latest"
    echo "   docker push ${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${BACKEND_REPO}:latest"
    echo ""
    echo "2. Force service update to pull new images:"
    echo "   aws ecs update-service --cluster ${CLUSTER_NAME} --service ${FRONTEND_SERVICE} --force-new-deployment"
    echo "   aws ecs update-service --cluster ${CLUSTER_NAME} --service ${BACKEND_SERVICE} --force-new-deployment"
    echo ""
    echo "3. Set up SSL certificate (see instructions above)"
    echo ""
    echo "============================================"
    echo "  Estimated Monthly Cost"
    echo "============================================"
    echo ""
    echo "  - ALB: ~\$16-20/month"
    echo "  - ECS Fargate (2 tasks): ~\$15-25/month"
    echo "  - CloudWatch Logs: ~\$1-3/month"
    echo "  - ECR: ~\$1/month"
    echo "  - Data transfer: ~\$5-10/month"
    echo ""
    echo "  Total: ~\$40-60/month (infrastructure only)"
    echo ""
}

# ============================================
# MAIN
# ============================================
main() {
    check_prerequisites

    echo "This script will create:"
    echo "  1. ECR repositories for Docker images"
    echo "  2. ECS Fargate cluster"
    echo "  3. Application Load Balancer"
    echo "  4. CloudWatch log groups"
    echo "  5. IAM roles for ECS tasks"
    echo "  6. ECS services (frontend + backend)"
    echo ""
    read -p "Continue? (y/n) " -n 1 -r
    echo ""

    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Aborted."
        exit 1
    fi

    create_ecr_repositories
    setup_networking
    create_ecs_cluster
    create_iam_roles
    create_log_groups
    create_alb
    create_task_definitions
    create_ecs_services
    print_ssl_instructions
    print_summary
}

# Run if executed directly
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi
