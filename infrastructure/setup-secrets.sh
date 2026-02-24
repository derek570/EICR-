#!/bin/bash
# ============================================
# CertMate — AWS Secrets Manager Setup
#
# Creates/updates the combined eicr/api-keys secret
# containing ALL API keys as a single JSON object.
#
# AWS secrets layout:
#   eicr/api-keys  — all API keys (this script)
#   eicr/database  — DB credentials (created separately)
# ============================================

set -e

AWS_REGION="eu-west-2"
SECRET_NAME="eicr/api-keys"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo "============================================"
echo "  CertMate — Secrets Manager Setup"
echo "  Region: ${AWS_REGION}"
echo "  Secret: ${SECRET_NAME}"
echo "============================================"
echo ""

# Pre-flight checks
if ! command -v aws &> /dev/null; then
    echo -e "${RED}ERROR: AWS CLI is not installed. Install with: brew install awscli${NC}"
    exit 1
fi

if ! aws sts get-caller-identity &> /dev/null; then
    echo -e "${RED}ERROR: AWS CLI is not configured. Run: aws configure${NC}"
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
echo "Enter your API keys (stored securely in AWS Secrets Manager):"
echo ""

read -p "OpenAI API Key (sk-...): " OPENAI_KEY
[ -z "$OPENAI_KEY" ] && echo -e "${RED}OpenAI API key is required.${NC}" && exit 1

read -p "Gemini API Key: " GEMINI_KEY
[ -z "$GEMINI_KEY" ] && echo -e "${RED}Gemini API key is required.${NC}" && exit 1

read -p "Anthropic API Key (sk-ant-...): " ANTHROPIC_KEY
[ -z "$ANTHROPIC_KEY" ] && echo -e "${RED}Anthropic API key is required.${NC}" && exit 1

read -p "Deepgram API Key: " DEEPGRAM_KEY
[ -z "$DEEPGRAM_KEY" ] && echo -e "${RED}Deepgram API key is required.${NC}" && exit 1

read -p "ElevenLabs API Key (optional, Enter to skip): " ELEVENLABS_KEY

read -p "JWT Secret (min 32 chars): " JWT_SECRET
[ -z "$JWT_SECRET" ] && echo -e "${RED}JWT secret is required.${NC}" && exit 1

read -p "Tradecert API Key (optional, Enter to skip): " TRADECERT_KEY

# Build the secret JSON using jq for proper escaping
if command -v jq &> /dev/null; then
    SECRET_JSON=$(jq -n \
        --arg openai "$OPENAI_KEY" \
        --arg gemini "$GEMINI_KEY" \
        --arg anthropic "$ANTHROPIC_KEY" \
        --arg deepgram "$DEEPGRAM_KEY" \
        --arg elevenlabs "$ELEVENLABS_KEY" \
        --arg jwt "$JWT_SECRET" \
        --arg tradecert "$TRADECERT_KEY" \
        '{
            OPENAI_API_KEY: $openai,
            GEMINI_API_KEY: $gemini,
            ANTHROPIC_API_KEY: $anthropic,
            DEEPGRAM_API_KEY: $deepgram,
            JWT_SECRET: $jwt
        }
        + (if $elevenlabs != "" then {ELEVENLABS_API_KEY: $elevenlabs} else {} end)
        + (if $tradecert != "" then {TRADECERT_API_KEY: $tradecert} else {} end)')
else
    # Fallback without jq — simple string construction
    SECRET_JSON="{\"OPENAI_API_KEY\":\"${OPENAI_KEY}\",\"GEMINI_API_KEY\":\"${GEMINI_KEY}\",\"ANTHROPIC_API_KEY\":\"${ANTHROPIC_KEY}\",\"DEEPGRAM_API_KEY\":\"${DEEPGRAM_KEY}\",\"JWT_SECRET\":\"${JWT_SECRET}\""
    [ -n "$ELEVENLABS_KEY" ] && SECRET_JSON="${SECRET_JSON},\"ELEVENLABS_API_KEY\":\"${ELEVENLABS_KEY}\""
    [ -n "$TRADECERT_KEY" ] && SECRET_JSON="${SECRET_JSON},\"TRADECERT_API_KEY\":\"${TRADECERT_KEY}\""
    SECRET_JSON="${SECRET_JSON}}"
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
        --description "CertMate API keys (all services)" \
        --secret-string "${SECRET_JSON}" \
        --region "${AWS_REGION}"
fi

echo ""
echo -e "${GREEN}Secret stored successfully!${NC}"
echo ""
echo "============================================"
echo "  Secret: ${SECRET_NAME}"
echo "  Region: ${AWS_REGION}"
echo "============================================"
echo ""
echo "Keys stored:"
echo "  - OPENAI_API_KEY"
echo "  - GEMINI_API_KEY"
echo "  - ANTHROPIC_API_KEY"
echo "  - DEEPGRAM_API_KEY"
echo "  - JWT_SECRET"
[ -n "$ELEVENLABS_KEY" ] && echo "  - ELEVENLABS_API_KEY"
[ -n "$TRADECERT_KEY" ] && echo "  - TRADECERT_API_KEY"
echo ""

# Create/update IAM policy
echo -e "${YELLOW}Creating IAM policy for secrets access...${NC}"

POLICY_NAME="eicr-secrets-policy"
SECRET_ARN=$(aws secretsmanager describe-secret --secret-id "${SECRET_NAME}" --region "${AWS_REGION}" --query 'ARN' --output text)
DB_SECRET_ARN=$(aws secretsmanager describe-secret --secret-id "eicr/database" --region "${AWS_REGION}" --query 'ARN' --output text 2>/dev/null || echo "")

# Build resource list — include database secret if it exists
RESOURCES="\"${SECRET_ARN}\""
[ -n "$DB_SECRET_ARN" ] && RESOURCES="${RESOURCES}, \"${DB_SECRET_ARN}\""

POLICY_DOC=$(cat <<EOF
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": ["secretsmanager:GetSecretValue"],
            "Resource": [${RESOURCES}]
        }
    ]
}
EOF
)

EXISTING_POLICY=$(aws iam list-policies --query "Policies[?PolicyName=='${POLICY_NAME}'].Arn" --output text)

if [ -n "$EXISTING_POLICY" ]; then
    echo "Policy exists, updating..."
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

# Attach to existing app user if it exists
APP_USER="eicr-app-user"
if aws iam get-user --user-name "${APP_USER}" 2>/dev/null; then
    aws iam attach-user-policy --user-name "${APP_USER}" --policy-arn "${POLICY_ARN}"
    echo -e "${GREEN}Policy attached to ${APP_USER}.${NC}"
fi

echo ""
echo -e "${GREEN}Setup complete.${NC}"
echo ""
echo "Usage in Node.js:"
echo "  import { getAnthropicKey } from './src/services/secrets.js';"
echo "  const key = await getAnthropicKey();"
echo ""
echo "Required env vars on ECS:"
echo "  USE_AWS_SECRETS=true"
echo "  AWS_REGION=${AWS_REGION}"
echo ""
