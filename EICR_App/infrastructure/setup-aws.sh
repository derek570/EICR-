#!/bin/bash
# ============================================
# EICR-oMatic 3000 - AWS Infrastructure Setup
# Phase 2: S3 Storage + RDS PostgreSQL
# ============================================

set -e

# Configuration
AWS_REGION="eu-west-2"
PROJECT_NAME="eicr"
ENVIRONMENT="production"

# S3 Configuration
S3_BUCKET_NAME="${PROJECT_NAME}-files-${ENVIRONMENT}"

# RDS Configuration
RDS_INSTANCE_ID="${PROJECT_NAME}-db-${ENVIRONMENT}"
RDS_DB_NAME="eicr"
RDS_USERNAME="eicr_admin"
RDS_INSTANCE_CLASS="db.t3.micro"  # Smallest/cheapest option
RDS_STORAGE_GB=20

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "============================================"
echo "  EICR-oMatic 3000 - AWS Setup"
echo "  Region: ${AWS_REGION}"
echo "============================================"
echo ""

# Check AWS CLI is installed and configured
check_aws_cli() {
    echo -e "${YELLOW}Checking AWS CLI...${NC}"
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
    echo ""
}

# ============================================
# S3 BUCKET SETUP
# ============================================
create_s3_bucket() {
    echo -e "${YELLOW}Creating S3 bucket: ${S3_BUCKET_NAME}...${NC}"

    # Check if bucket already exists
    if aws s3api head-bucket --bucket "${S3_BUCKET_NAME}" 2>/dev/null; then
        echo -e "${GREEN}S3 bucket already exists.${NC}"
    else
        # Create bucket (eu-west-2 requires LocationConstraint)
        aws s3api create-bucket \
            --bucket "${S3_BUCKET_NAME}" \
            --region "${AWS_REGION}" \
            --create-bucket-configuration LocationConstraint="${AWS_REGION}"

        echo -e "${GREEN}S3 bucket created.${NC}"
    fi

    # Enable versioning for data protection
    echo "Enabling versioning..."
    aws s3api put-bucket-versioning \
        --bucket "${S3_BUCKET_NAME}" \
        --versioning-configuration Status=Enabled

    # Block public access
    echo "Blocking public access..."
    aws s3api put-public-access-block \
        --bucket "${S3_BUCKET_NAME}" \
        --public-access-block-configuration \
        "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"

    # Enable server-side encryption
    echo "Enabling encryption..."
    aws s3api put-bucket-encryption \
        --bucket "${S3_BUCKET_NAME}" \
        --server-side-encryption-configuration \
        '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'

    # Create folder structure
    echo "Creating folder structure..."
    for folder in "incoming" "output" "done" "failed" "assets"; do
        aws s3api put-object --bucket "${S3_BUCKET_NAME}" --key "${folder}/"
    done

    echo -e "${GREEN}S3 bucket configured successfully!${NC}"
    echo "  Bucket: s3://${S3_BUCKET_NAME}"
    echo ""
}

# ============================================
# RDS POSTGRESQL SETUP
# ============================================
create_rds_instance() {
    echo -e "${YELLOW}Setting up RDS PostgreSQL...${NC}"

    # Check if instance already exists
    if aws rds describe-db-instances --db-instance-identifier "${RDS_INSTANCE_ID}" 2>/dev/null; then
        echo -e "${GREEN}RDS instance already exists.${NC}"
        return
    fi

    # Generate a random password
    RDS_PASSWORD=$(openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | head -c 20)

    # Get default VPC
    echo "Getting default VPC..."
    VPC_ID=$(aws ec2 describe-vpcs --filters "Name=isDefault,Values=true" --query "Vpcs[0].VpcId" --output text)

    if [ "$VPC_ID" == "None" ] || [ -z "$VPC_ID" ]; then
        echo -e "${RED}ERROR: No default VPC found. Please create a VPC first.${NC}"
        exit 1
    fi
    echo "  VPC: ${VPC_ID}"

    # Create security group for RDS
    echo "Creating security group..."
    SG_NAME="${PROJECT_NAME}-rds-sg"

    # Check if security group exists
    SG_ID=$(aws ec2 describe-security-groups \
        --filters "Name=group-name,Values=${SG_NAME}" \
        --query "SecurityGroups[0].GroupId" --output text 2>/dev/null)

    if [ "$SG_ID" == "None" ] || [ -z "$SG_ID" ]; then
        SG_ID=$(aws ec2 create-security-group \
            --group-name "${SG_NAME}" \
            --description "Security group for EICR RDS PostgreSQL" \
            --vpc-id "${VPC_ID}" \
            --query "GroupId" --output text)

        # Allow PostgreSQL access from anywhere (restrict in production!)
        aws ec2 authorize-security-group-ingress \
            --group-id "${SG_ID}" \
            --protocol tcp \
            --port 5432 \
            --cidr 0.0.0.0/0

        echo "  Security Group created: ${SG_ID}"
    else
        echo "  Security Group exists: ${SG_ID}"
    fi

    # Create DB subnet group
    echo "Creating DB subnet group..."
    SUBNET_GROUP_NAME="${PROJECT_NAME}-db-subnet-group"

    if ! aws rds describe-db-subnet-groups --db-subnet-group-name "${SUBNET_GROUP_NAME}" 2>/dev/null; then
        # Get all subnets in the VPC
        SUBNET_IDS=$(aws ec2 describe-subnets \
            --filters "Name=vpc-id,Values=${VPC_ID}" \
            --query "Subnets[*].SubnetId" --output text | tr '\t' ' ')

        aws rds create-db-subnet-group \
            --db-subnet-group-name "${SUBNET_GROUP_NAME}" \
            --db-subnet-group-description "Subnet group for EICR database" \
            --subnet-ids ${SUBNET_IDS}

        echo "  DB Subnet Group created"
    else
        echo "  DB Subnet Group exists"
    fi

    # Create RDS instance
    echo "Creating RDS PostgreSQL instance (this may take 5-10 minutes)..."
    aws rds create-db-instance \
        --db-instance-identifier "${RDS_INSTANCE_ID}" \
        --db-instance-class "${RDS_INSTANCE_CLASS}" \
        --engine postgres \
        --engine-version "15" \
        --master-username "${RDS_USERNAME}" \
        --master-user-password "${RDS_PASSWORD}" \
        --allocated-storage "${RDS_STORAGE_GB}" \
        --db-name "${RDS_DB_NAME}" \
        --vpc-security-group-ids "${SG_ID}" \
        --db-subnet-group-name "${SUBNET_GROUP_NAME}" \
        --backup-retention-period 7 \
        --no-multi-az \
        --storage-type gp2 \
        --publicly-accessible \
        --no-deletion-protection

    echo ""
    echo -e "${GREEN}RDS instance creation started!${NC}"
    echo ""
    echo "============================================"
    echo -e "${RED}IMPORTANT: Save these credentials securely!${NC}"
    echo "============================================"
    echo "  Database Name: ${RDS_DB_NAME}"
    echo "  Username: ${RDS_USERNAME}"
    echo "  Password: ${RDS_PASSWORD}"
    echo ""
    echo "The instance is being created. Run this to check status:"
    echo "  aws rds describe-db-instances --db-instance-identifier ${RDS_INSTANCE_ID} --query 'DBInstances[0].DBInstanceStatus'"
    echo ""
    echo "Once available, get the endpoint with:"
    echo "  aws rds describe-db-instances --db-instance-identifier ${RDS_INSTANCE_ID} --query 'DBInstances[0].Endpoint.Address' --output text"
    echo ""
}

# ============================================
# CREATE IAM USER FOR APPLICATION
# ============================================
create_iam_user() {
    echo -e "${YELLOW}Creating IAM user for application...${NC}"

    IAM_USER_NAME="${PROJECT_NAME}-app-user"

    # Check if user exists
    if aws iam get-user --user-name "${IAM_USER_NAME}" 2>/dev/null; then
        echo -e "${GREEN}IAM user already exists.${NC}"
        return
    fi

    # Create user
    aws iam create-user --user-name "${IAM_USER_NAME}"

    # Create policy for S3 access
    POLICY_NAME="${PROJECT_NAME}-s3-policy"
    POLICY_DOC=$(cat <<EOF
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
                "arn:aws:s3:::${S3_BUCKET_NAME}",
                "arn:aws:s3:::${S3_BUCKET_NAME}/*"
            ]
        }
    ]
}
EOF
)

    # Create and attach policy
    POLICY_ARN=$(aws iam create-policy \
        --policy-name "${POLICY_NAME}" \
        --policy-document "${POLICY_DOC}" \
        --query "Policy.Arn" --output text 2>/dev/null || \
        aws iam list-policies --query "Policies[?PolicyName=='${POLICY_NAME}'].Arn" --output text)

    aws iam attach-user-policy --user-name "${IAM_USER_NAME}" --policy-arn "${POLICY_ARN}"

    # Create access key
    echo "Creating access key..."
    CREDENTIALS=$(aws iam create-access-key --user-name "${IAM_USER_NAME}")
    ACCESS_KEY=$(echo "${CREDENTIALS}" | grep -o '"AccessKeyId": "[^"]*' | cut -d'"' -f4)
    SECRET_KEY=$(echo "${CREDENTIALS}" | grep -o '"SecretAccessKey": "[^"]*' | cut -d'"' -f4)

    echo ""
    echo -e "${GREEN}IAM user created!${NC}"
    echo ""
    echo "============================================"
    echo -e "${RED}IMPORTANT: Save these credentials securely!${NC}"
    echo "============================================"
    echo "  AWS_ACCESS_KEY_ID=${ACCESS_KEY}"
    echo "  AWS_SECRET_ACCESS_KEY=${SECRET_KEY}"
    echo ""
}

# ============================================
# GENERATE .ENV FILE
# ============================================
generate_env_file() {
    echo -e "${YELLOW}Generating environment file...${NC}"

    ENV_FILE="../.env.aws"

    cat > "${ENV_FILE}" <<EOF
# AWS Configuration for EICR-oMatic 3000
# Generated: $(date)

# Storage
STORAGE_TYPE=s3
AWS_REGION=${AWS_REGION}
S3_BUCKET_NAME=${S3_BUCKET_NAME}

# Database (update endpoint after RDS is available)
DATABASE_TYPE=postgresql
DATABASE_HOST=<RDS_ENDPOINT_HERE>
DATABASE_PORT=5432
DATABASE_NAME=${RDS_DB_NAME}
DATABASE_USER=${RDS_USERNAME}
DATABASE_PASSWORD=<RDS_PASSWORD_HERE>

# AWS Credentials (for application)
AWS_ACCESS_KEY_ID=<IAM_ACCESS_KEY_HERE>
AWS_SECRET_ACCESS_KEY=<IAM_SECRET_KEY_HERE>
EOF

    echo -e "${GREEN}Environment template created: ${ENV_FILE}${NC}"
    echo "Update the placeholder values with your actual credentials."
    echo ""
}

# ============================================
# MAIN
# ============================================
main() {
    check_aws_cli

    echo "This script will create:"
    echo "  1. S3 bucket: ${S3_BUCKET_NAME}"
    echo "  2. RDS PostgreSQL: ${RDS_INSTANCE_ID}"
    echo "  3. IAM user with S3 permissions"
    echo ""
    read -p "Continue? (y/n) " -n 1 -r
    echo ""

    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Aborted."
        exit 1
    fi

    create_s3_bucket
    create_rds_instance
    create_iam_user
    generate_env_file

    echo ""
    echo "============================================"
    echo -e "${GREEN}AWS Infrastructure Setup Complete!${NC}"
    echo "============================================"
    echo ""
    echo "Next steps:"
    echo "  1. Wait for RDS instance to become available (~5-10 min)"
    echo "  2. Get RDS endpoint and update .env.aws"
    echo "  3. Update your application's .env with the new values"
    echo "  4. Test database connection"
    echo ""
    echo "Estimated monthly cost:"
    echo "  - S3: ~\$1-5/month (depending on storage)"
    echo "  - RDS db.t3.micro: ~\$15-20/month"
    echo ""
}

# Run if executed directly
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi
