#!/bin/bash
# ============================================
# EICR-oMatic 3000 - AWS Secrets Manager Setup
# Securely store API keys and credentials
# ============================================

set -e

# Configuration
AWS_REGION="eu-west-2"
PROJECT_NAME="eicr"
SECRET_NAME="${PROJECT_NAME}/api-keys"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo "============================================"
echo "  EICR-oMatic 3000 - Secrets Manager Setup"
echo "  Region: ${AWS_REGION}"
echo "============================================"
echo ""

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

echo -e "${GREEN}AWS CLI configured.${NC}"
echo ""

# Check if secret already exists
SECRET_EXISTS=$(aws secretsmanager describe-secret --secret-id "${SECRET_NAME}" --region "${AWS_REGION}" 2>/dev/null && echo "yes" || echo "no")

if [ "$SECRET_EXISTS" == "yes" ]; then
    echo -e "${YELLOW}Secret '${SECRET_NAME}' already exists.${NC}"
    echo ""
    read -p "Update existing secret? (y/n) " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Aborted."
        exit 0
    fi
    UPDATE_MODE="true"
else
    UPDATE_MODE="false"
fi

# Collect API keys
echo ""
echo "Enter your API keys (they will be stored securely in AWS):"
echo ""

read -p "OpenAI API Key (sk-...): " OPENAI_KEY
if [ -z "$OPENAI_KEY" ]; then
    echo -e "${RED}OpenAI API key is required.${NC}"
    exit 1
fi

read -p "Gemini API Key: " GEMINI_KEY
if [ -z "$GEMINI_KEY" ]; then
    echo -e "${RED}Gemini API key is required.${NC}"
    exit 1
fi

read -p "Tradecert API Key (optional, press Enter to skip): " TRADECERT_KEY

# Build the secret JSON
SECRET_JSON=$(cat <<EOF
{
    "OPENAI_API_KEY": "${OPENAI_KEY}",
    "GEMINI_API_KEY": "${GEMINI_KEY}"
EOF
)

if [ -n "$TRADECERT_KEY" ]; then
    SECRET_JSON=$(cat <<EOF
{
    "OPENAI_API_KEY": "${OPENAI_KEY}",
    "GEMINI_API_KEY": "${GEMINI_KEY}",
    "TRADECERT_API_KEY": "${TRADECERT_KEY}"
}
EOF
)
else
    SECRET_JSON="${SECRET_JSON}
}"
fi

# Create or update the secret
echo ""
if [ "$UPDATE_MODE" == "true" ]; then
    echo -e "${YELLOW}Updating secret...${NC}"
    aws secretsmanager update-secret \
        --secret-id "${SECRET_NAME}" \
        --secret-string "${SECRET_JSON}" \
        --region "${AWS_REGION}"
else
    echo -e "${YELLOW}Creating secret...${NC}"
    aws secretsmanager create-secret \
        --name "${SECRET_NAME}" \
        --description "API keys for EICR-oMatic 3000" \
        --secret-string "${SECRET_JSON}" \
        --region "${AWS_REGION}"
fi

echo ""
echo -e "${GREEN}Secret stored successfully!${NC}"
echo ""
echo "============================================"
echo "  Secret Details"
echo "============================================"
echo "  Name: ${SECRET_NAME}"
echo "  Region: ${AWS_REGION}"
echo "  ARN: $(aws secretsmanager describe-secret --secret-id "${SECRET_NAME}" --region "${AWS_REGION}" --query 'ARN' --output text)"
echo ""
echo "Keys stored:"
echo "  - OPENAI_API_KEY"
echo "  - GEMINI_API_KEY"
[ -n "$TRADECERT_KEY" ] && echo "  - TRADECERT_API_KEY"
echo ""

# Create IAM policy for accessing secrets
echo -e "${YELLOW}Creating IAM policy for secrets access...${NC}"

POLICY_NAME="${PROJECT_NAME}-secrets-policy"
SECRET_ARN=$(aws secretsmanager describe-secret --secret-id "${SECRET_NAME}" --region "${AWS_REGION}" --query 'ARN' --output text)

POLICY_DOC=$(cat <<EOF
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": [
                "secretsmanager:GetSecretValue"
            ],
            "Resource": "${SECRET_ARN}"
        }
    ]
}
EOF
)

# Check if policy exists
EXISTING_POLICY=$(aws iam list-policies --query "Policies[?PolicyName=='${POLICY_NAME}'].Arn" --output text)

if [ -n "$EXISTING_POLICY" ]; then
    echo "Policy already exists, updating..."
    # Get policy version and create new version
    aws iam create-policy-version \
        --policy-arn "${EXISTING_POLICY}" \
        --policy-document "${POLICY_DOC}" \
        --set-as-default 2>/dev/null || true
    POLICY_ARN="${EXISTING_POLICY}"
else
    POLICY_ARN=$(aws iam create-policy \
        --policy-name "${POLICY_NAME}" \
        --policy-document "${POLICY_DOC}" \
        --query "Policy.Arn" --output text)
fi

echo -e "${GREEN}IAM policy created/updated: ${POLICY_ARN}${NC}"
echo ""

# Attach to existing app user if it exists
APP_USER="${PROJECT_NAME}-app-user"
if aws iam get-user --user-name "${APP_USER}" 2>/dev/null; then
    echo "Attaching policy to ${APP_USER}..."
    aws iam attach-user-policy --user-name "${APP_USER}" --policy-arn "${POLICY_ARN}"
    echo -e "${GREEN}Policy attached to user.${NC}"
fi

echo ""
echo "============================================"
echo -e "${GREEN}Secrets Manager Setup Complete!${NC}"
echo "============================================"
echo ""
echo "Your app can now retrieve secrets using:"
echo ""
echo "  Python:"
echo "    from secrets_manager import get_secret"
echo "    api_key = get_secret('OPENAI_API_KEY')"
echo ""
echo "  Node.js:"
echo "    import { getSecret } from './src/secrets.js'"
echo "    const apiKey = await getSecret('OPENAI_API_KEY')"
echo ""
echo "Environment variable to set:"
echo "  AWS_REGION=${AWS_REGION}"
echo "  USE_AWS_SECRETS=true"
echo ""
