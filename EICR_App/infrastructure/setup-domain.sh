#!/bin/bash
# ============================================
# EICR-oMatic 3000 - Domain & SSL Setup
# Links custom domain to ALB with HTTPS
# ============================================

set -e

# Configuration
AWS_REGION="eu-west-2"
PROJECT_NAME="eicr"
ENVIRONMENT="production"
ALB_NAME="${PROJECT_NAME}-alb-${ENVIRONMENT}"
TARGET_GROUP_FRONTEND="${PROJECT_NAME}-tg-frontend"
TARGET_GROUP_BACKEND="${PROJECT_NAME}-tg-backend"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo "============================================"
echo "  EICR-oMatic 3000 - Domain & SSL Setup"
echo "  Region: ${AWS_REGION}"
echo "============================================"
echo ""

# ============================================
# PRE-FLIGHT CHECKS
# ============================================
check_prerequisites() {
    echo -e "${YELLOW}Checking prerequisites...${NC}"

    if ! command -v aws &> /dev/null; then
        echo -e "${RED}ERROR: AWS CLI is not installed.${NC}"
        exit 1
    fi

    if ! aws sts get-caller-identity &> /dev/null; then
        echo -e "${RED}ERROR: AWS CLI is not configured.${NC}"
        exit 1
    fi

    ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
    echo -e "${GREEN}AWS Account: ${ACCOUNT_ID}${NC}"

    # Get ALB ARN and DNS
    ALB_ARN=$(aws elbv2 describe-load-balancers \
        --names "${ALB_NAME}" \
        --region "${AWS_REGION}" \
        --query "LoadBalancers[0].LoadBalancerArn" --output text 2>/dev/null || echo "")

    if [ -z "$ALB_ARN" ] || [ "$ALB_ARN" == "None" ]; then
        echo -e "${RED}ERROR: ALB '${ALB_NAME}' not found. Run setup-ecs.sh first.${NC}"
        exit 1
    fi

    ALB_DNS=$(aws elbv2 describe-load-balancers \
        --load-balancer-arns "${ALB_ARN}" \
        --region "${AWS_REGION}" \
        --query "LoadBalancers[0].DNSName" --output text)

    ALB_HOSTED_ZONE=$(aws elbv2 describe-load-balancers \
        --load-balancer-arns "${ALB_ARN}" \
        --region "${AWS_REGION}" \
        --query "LoadBalancers[0].CanonicalHostedZoneId" --output text)

    echo -e "${GREEN}ALB found: ${ALB_DNS}${NC}"

    # Get frontend target group ARN
    FRONTEND_TG_ARN=$(aws elbv2 describe-target-groups \
        --names "${TARGET_GROUP_FRONTEND}" \
        --region "${AWS_REGION}" \
        --query "TargetGroups[0].TargetGroupArn" --output text 2>/dev/null || echo "")

    if [ -z "$FRONTEND_TG_ARN" ] || [ "$FRONTEND_TG_ARN" == "None" ]; then
        echo -e "${RED}ERROR: Target group '${TARGET_GROUP_FRONTEND}' not found.${NC}"
        exit 1
    fi

    echo ""
}

# ============================================
# DOMAIN REGISTRATION INFO
# ============================================
show_domain_registration_info() {
    echo "============================================"
    echo -e "${BLUE}Step 1: Register a Domain${NC}"
    echo "============================================"
    echo ""
    echo "To register a domain via Route 53:"
    echo ""
    echo "  1. Go to AWS Console -> Route 53 -> Registered domains"
    echo "     https://console.aws.amazon.com/route53/home#DomainRegistration:"
    echo ""
    echo "  2. Click 'Register Domain'"
    echo ""
    echo "  3. Search for your desired domain name"
    echo "     Suggestions for EICR business:"
    echo "       - eicr-omatic.co.uk (~£9/year)"
    echo "       - myeicr.co.uk (~£9/year)"
    echo "       - eicr-reports.co.uk (~£9/year)"
    echo "       - [yourcompany]-eicr.co.uk"
    echo ""
    echo "  4. Complete registration (takes 10-30 mins to complete)"
    echo ""
    echo "  5. Route 53 automatically creates a Hosted Zone for your domain"
    echo ""
    echo -e "${YELLOW}NOTE: Domain registration cannot be automated via CLI.${NC}"
    echo -e "${YELLOW}      Complete registration in AWS Console first.${NC}"
    echo ""
}

# ============================================
# GET DOMAIN FROM USER
# ============================================
get_domain_input() {
    echo "============================================"
    echo -e "${BLUE}Enter Your Domain${NC}"
    echo "============================================"
    echo ""
    read -p "Enter your registered domain name (e.g., eicr-omatic.co.uk): " DOMAIN_NAME
    echo ""

    if [ -z "$DOMAIN_NAME" ]; then
        echo -e "${RED}ERROR: Domain name is required.${NC}"
        exit 1
    fi

    # Remove any protocol prefix
    DOMAIN_NAME=$(echo "$DOMAIN_NAME" | sed 's|https://||' | sed 's|http://||' | sed 's|/||g')

    echo -e "Domain: ${GREEN}${DOMAIN_NAME}${NC}"
    echo ""
}

# ============================================
# VERIFY HOSTED ZONE EXISTS
# ============================================
verify_hosted_zone() {
    echo -e "${BLUE}[1/4] Verifying Route 53 Hosted Zone...${NC}"

    HOSTED_ZONE_ID=$(aws route53 list-hosted-zones-by-name \
        --dns-name "${DOMAIN_NAME}" \
        --query "HostedZones[?Name=='${DOMAIN_NAME}.'].Id" --output text | head -1 | sed 's|/hostedzone/||')

    if [ -z "$HOSTED_ZONE_ID" ] || [ "$HOSTED_ZONE_ID" == "None" ]; then
        echo -e "${RED}ERROR: No hosted zone found for ${DOMAIN_NAME}${NC}"
        echo ""
        echo "This usually means:"
        echo "  1. Domain registration hasn't completed yet (wait 10-30 mins)"
        echo "  2. Domain was registered elsewhere (need to create hosted zone manually)"
        echo ""
        echo "To create a hosted zone manually:"
        echo "  aws route53 create-hosted-zone --name ${DOMAIN_NAME} --caller-reference \$(date +%s)"
        echo ""
        exit 1
    fi

    echo -e "  ${GREEN}Hosted Zone found: ${HOSTED_ZONE_ID}${NC}"
    echo ""
}

# ============================================
# REQUEST SSL CERTIFICATE
# ============================================
request_ssl_certificate() {
    echo -e "${BLUE}[2/4] Requesting SSL Certificate...${NC}"

    # Check for existing certificate
    EXISTING_CERT=$(aws acm list-certificates \
        --region "${AWS_REGION}" \
        --query "CertificateSummaryList[?DomainName=='${DOMAIN_NAME}'].CertificateArn" --output text | head -1)

    if [ -n "$EXISTING_CERT" ] && [ "$EXISTING_CERT" != "None" ]; then
        CERT_STATUS=$(aws acm describe-certificate \
            --certificate-arn "${EXISTING_CERT}" \
            --region "${AWS_REGION}" \
            --query "Certificate.Status" --output text)

        if [ "$CERT_STATUS" == "ISSUED" ]; then
            echo -e "  ${GREEN}Certificate already exists and is valid.${NC}"
            CERTIFICATE_ARN="${EXISTING_CERT}"
            return
        fi

        echo "  Existing certificate found (Status: ${CERT_STATUS})"
        CERTIFICATE_ARN="${EXISTING_CERT}"
    else
        # Request new certificate for domain and www subdomain
        CERTIFICATE_ARN=$(aws acm request-certificate \
            --domain-name "${DOMAIN_NAME}" \
            --subject-alternative-names "*.${DOMAIN_NAME}" \
            --validation-method DNS \
            --region "${AWS_REGION}" \
            --query "CertificateArn" --output text)

        echo -e "  ${GREEN}Certificate requested: ${CERTIFICATE_ARN}${NC}"
    fi

    # Wait a moment for ACM to generate validation records
    echo "  Waiting for validation records..."
    sleep 5

    # Get validation records
    VALIDATION_RECORDS=$(aws acm describe-certificate \
        --certificate-arn "${CERTIFICATE_ARN}" \
        --region "${AWS_REGION}" \
        --query "Certificate.DomainValidationOptions")

    echo ""
}

# ============================================
# CREATE DNS VALIDATION RECORDS
# ============================================
create_validation_records() {
    echo -e "${BLUE}[3/4] Creating DNS Validation Records...${NC}"

    # Get validation record details
    VALIDATION_NAME=$(aws acm describe-certificate \
        --certificate-arn "${CERTIFICATE_ARN}" \
        --region "${AWS_REGION}" \
        --query "Certificate.DomainValidationOptions[0].ResourceRecord.Name" --output text)

    VALIDATION_VALUE=$(aws acm describe-certificate \
        --certificate-arn "${CERTIFICATE_ARN}" \
        --region "${AWS_REGION}" \
        --query "Certificate.DomainValidationOptions[0].ResourceRecord.Value" --output text)

    if [ -z "$VALIDATION_NAME" ] || [ "$VALIDATION_NAME" == "None" ]; then
        echo -e "${YELLOW}  Waiting for validation records to be generated...${NC}"
        sleep 10

        VALIDATION_NAME=$(aws acm describe-certificate \
            --certificate-arn "${CERTIFICATE_ARN}" \
            --region "${AWS_REGION}" \
            --query "Certificate.DomainValidationOptions[0].ResourceRecord.Name" --output text)

        VALIDATION_VALUE=$(aws acm describe-certificate \
            --certificate-arn "${CERTIFICATE_ARN}" \
            --region "${AWS_REGION}" \
            --query "Certificate.DomainValidationOptions[0].ResourceRecord.Value" --output text)
    fi

    # Create CNAME record for validation
    CHANGE_BATCH=$(cat <<EOF
{
    "Changes": [
        {
            "Action": "UPSERT",
            "ResourceRecordSet": {
                "Name": "${VALIDATION_NAME}",
                "Type": "CNAME",
                "TTL": 300,
                "ResourceRecords": [
                    {"Value": "${VALIDATION_VALUE}"}
                ]
            }
        }
    ]
}
EOF
)

    aws route53 change-resource-record-sets \
        --hosted-zone-id "${HOSTED_ZONE_ID}" \
        --change-batch "${CHANGE_BATCH}" > /dev/null 2>&1 || true

    echo -e "  ${GREEN}Validation DNS record created.${NC}"
    echo ""

    # Wait for certificate validation
    echo "  Waiting for certificate validation (this can take 2-5 minutes)..."

    MAX_ATTEMPTS=30
    ATTEMPT=0
    while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
        CERT_STATUS=$(aws acm describe-certificate \
            --certificate-arn "${CERTIFICATE_ARN}" \
            --region "${AWS_REGION}" \
            --query "Certificate.Status" --output text)

        if [ "$CERT_STATUS" == "ISSUED" ]; then
            echo -e "  ${GREEN}Certificate validated and issued!${NC}"
            break
        fi

        ATTEMPT=$((ATTEMPT + 1))
        echo "  Status: ${CERT_STATUS} (attempt ${ATTEMPT}/${MAX_ATTEMPTS})..."
        sleep 10
    done

    if [ "$CERT_STATUS" != "ISSUED" ]; then
        echo -e "${YELLOW}  Certificate not yet validated. It may take a few more minutes.${NC}"
        echo "  You can check status with:"
        echo "    aws acm describe-certificate --certificate-arn ${CERTIFICATE_ARN} --region ${AWS_REGION}"
        echo ""
        echo "  Continuing with setup - HTTPS listener will work once certificate is validated."
    fi

    echo ""
}

# ============================================
# CREATE DNS RECORDS FOR DOMAIN
# ============================================
create_domain_records() {
    echo -e "${BLUE}[4/4] Creating DNS Records...${NC}"

    # Create A record (alias) pointing to ALB
    CHANGE_BATCH=$(cat <<EOF
{
    "Changes": [
        {
            "Action": "UPSERT",
            "ResourceRecordSet": {
                "Name": "${DOMAIN_NAME}",
                "Type": "A",
                "AliasTarget": {
                    "HostedZoneId": "${ALB_HOSTED_ZONE}",
                    "DNSName": "${ALB_DNS}",
                    "EvaluateTargetHealth": true
                }
            }
        },
        {
            "Action": "UPSERT",
            "ResourceRecordSet": {
                "Name": "www.${DOMAIN_NAME}",
                "Type": "A",
                "AliasTarget": {
                    "HostedZoneId": "${ALB_HOSTED_ZONE}",
                    "DNSName": "${ALB_DNS}",
                    "EvaluateTargetHealth": true
                }
            }
        }
    ]
}
EOF
)

    aws route53 change-resource-record-sets \
        --hosted-zone-id "${HOSTED_ZONE_ID}" \
        --change-batch "${CHANGE_BATCH}" > /dev/null

    echo -e "  ${GREEN}DNS A records created for ${DOMAIN_NAME} and www.${DOMAIN_NAME}${NC}"
    echo ""
}

# ============================================
# CONFIGURE ALB HTTPS LISTENER
# ============================================
configure_https_listener() {
    echo -e "${BLUE}Configuring HTTPS Listener...${NC}"

    # Get backend target group ARN for API routing
    BACKEND_TG_ARN=$(aws elbv2 describe-target-groups \
        --names "${TARGET_GROUP_BACKEND}" \
        --region "${AWS_REGION}" \
        --query "TargetGroups[0].TargetGroupArn" --output text 2>/dev/null || echo "")

    # Check if HTTPS listener already exists
    HTTPS_LISTENER=$(aws elbv2 describe-listeners \
        --load-balancer-arn "${ALB_ARN}" \
        --region "${AWS_REGION}" \
        --query "Listeners[?Port==\`443\`].ListenerArn" --output text 2>/dev/null || echo "")

    if [ -n "$HTTPS_LISTENER" ] && [ "$HTTPS_LISTENER" != "None" ]; then
        echo "  HTTPS listener already exists. Updating certificate..."
        aws elbv2 modify-listener \
            --listener-arn "${HTTPS_LISTENER}" \
            --certificates CertificateArn="${CERTIFICATE_ARN}" \
            --region "${AWS_REGION}" > /dev/null
        echo -e "  ${GREEN}HTTPS listener updated.${NC}"
    else
        # Create HTTPS listener
        HTTPS_LISTENER=$(aws elbv2 create-listener \
            --load-balancer-arn "${ALB_ARN}" \
            --protocol HTTPS \
            --port 443 \
            --certificates CertificateArn="${CERTIFICATE_ARN}" \
            --default-actions Type=forward,TargetGroupArn="${FRONTEND_TG_ARN}" \
            --region "${AWS_REGION}" \
            --query "Listeners[0].ListenerArn" --output text)

        echo -e "  ${GREEN}HTTPS listener created on port 443.${NC}"
    fi

    # Add /api/* routing rule for HTTPS listener (routes to backend)
    if [ -n "$BACKEND_TG_ARN" ] && [ "$BACKEND_TG_ARN" != "None" ] && [ -n "$HTTPS_LISTENER" ]; then
        EXISTING_RULES=$(aws elbv2 describe-rules \
            --listener-arn "${HTTPS_LISTENER}" \
            --region "${AWS_REGION}" \
            --query "Rules[?Conditions[?Field=='path-pattern' && Values[?contains(@, '/api/*')]]].RuleArn" --output text 2>/dev/null || echo "")

        if [ -z "$EXISTING_RULES" ] || [ "$EXISTING_RULES" == "None" ]; then
            aws elbv2 create-rule \
                --listener-arn "${HTTPS_LISTENER}" \
                --priority 10 \
                --conditions Field=path-pattern,Values='/api/*' \
                --actions Type=forward,TargetGroupArn="${BACKEND_TG_ARN}" \
                --region "${AWS_REGION}" > /dev/null

            echo -e "  ${GREEN}Created routing rule: /api/* -> backend (HTTPS)${NC}"
        else
            echo "  Routing rule for /api/* already exists (HTTPS)"
        fi
    fi

    # Update HTTP listener to redirect to HTTPS
    HTTP_LISTENER=$(aws elbv2 describe-listeners \
        --load-balancer-arn "${ALB_ARN}" \
        --region "${AWS_REGION}" \
        --query "Listeners[?Port==\`80\`].ListenerArn" --output text 2>/dev/null || echo "")

    if [ -n "$HTTP_LISTENER" ] && [ "$HTTP_LISTENER" != "None" ]; then
        aws elbv2 modify-listener \
            --listener-arn "${HTTP_LISTENER}" \
            --default-actions Type=redirect,RedirectConfig="{Protocol=HTTPS,Port=443,StatusCode=HTTP_301}" \
            --region "${AWS_REGION}" > /dev/null

        echo -e "  ${GREEN}HTTP listener updated to redirect to HTTPS.${NC}"
    fi

    echo ""
}

# ============================================
# SUMMARY
# ============================================
print_summary() {
    echo ""
    echo "============================================"
    echo -e "${GREEN}Domain Setup Complete!${NC}"
    echo "============================================"
    echo ""
    echo "Your EICR-oMatic 3000 is now accessible at:"
    echo ""
    echo -e "  ${GREEN}https://${DOMAIN_NAME}${NC}"
    echo -e "  ${GREEN}https://www.${DOMAIN_NAME}${NC}"
    echo ""
    echo "DNS propagation may take 5-10 minutes."
    echo ""
    echo "To verify DNS is working:"
    echo "  dig ${DOMAIN_NAME}"
    echo "  nslookup ${DOMAIN_NAME}"
    echo ""
    echo "============================================"
    echo "  Summary"
    echo "============================================"
    echo ""
    echo "  Domain: ${DOMAIN_NAME}"
    echo "  Hosted Zone: ${HOSTED_ZONE_ID}"
    echo "  Certificate: ${CERTIFICATE_ARN}"
    echo "  ALB: ${ALB_DNS}"
    echo ""
    echo "============================================"
    echo ""
}

# ============================================
# MAIN
# ============================================
main() {
    check_prerequisites
    show_domain_registration_info

    echo ""
    read -p "Have you registered your domain in Route 53? (y/n) " -n 1 -r
    echo ""

    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo ""
        echo "Please register your domain first at:"
        echo "  https://console.aws.amazon.com/route53/home#DomainRegistration:"
        echo ""
        echo "Then run this script again."
        exit 0
    fi

    get_domain_input
    verify_hosted_zone
    request_ssl_certificate
    create_validation_records
    create_domain_records
    configure_https_listener
    print_summary
}

# Run if executed directly
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi
