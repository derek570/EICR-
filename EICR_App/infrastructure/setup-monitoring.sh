#!/bin/bash
# ============================================
# EICR-oMatic 3000 - AWS Monitoring Setup
# Phase 4: Production Hardening - Alerts
# ============================================

set -e

# Configuration
AWS_REGION="eu-west-2"
PROJECT_NAME="eicr"
ENVIRONMENT="production"

# Resource names (must match setup-ecs.sh)
CLUSTER_NAME="${PROJECT_NAME}-cluster-${ENVIRONMENT}"
FRONTEND_SERVICE="${PROJECT_NAME}-frontend"
BACKEND_SERVICE="${PROJECT_NAME}-backend"
ALB_NAME="${PROJECT_NAME}-alb-${ENVIRONMENT}"
RDS_INSTANCE_ID="${PROJECT_NAME}-db-${ENVIRONMENT}"

# SNS Configuration
SNS_TOPIC_NAME="${PROJECT_NAME}-alerts-${ENVIRONMENT}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo "============================================"
echo "  EICR-oMatic 3000 - Monitoring Setup"
echo "  Phase 4: Production Hardening"
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
    echo -e "${GREEN}AWS CLI configured. Account: ${ACCOUNT_ID}${NC}"
    echo ""
}

# ============================================
# SNS TOPIC FOR NOTIFICATIONS
# ============================================
create_sns_topic() {
    echo -e "${BLUE}[1/5] Creating SNS Topic for Alerts...${NC}"

    # Check if topic exists
    SNS_TOPIC_ARN=$(aws sns list-topics --region "${AWS_REGION}" \
        --query "Topics[?contains(TopicArn, '${SNS_TOPIC_NAME}')].TopicArn" --output text)

    if [ -z "$SNS_TOPIC_ARN" ] || [ "$SNS_TOPIC_ARN" == "None" ]; then
        SNS_TOPIC_ARN=$(aws sns create-topic \
            --name "${SNS_TOPIC_NAME}" \
            --region "${AWS_REGION}" \
            --query "TopicArn" --output text)

        echo -e "  ${GREEN}Created SNS topic: ${SNS_TOPIC_NAME}${NC}"
    else
        echo "  SNS topic exists: ${SNS_TOPIC_NAME}"
    fi

    echo ""
    echo -e "  ${YELLOW}IMPORTANT: Subscribe to receive alerts!${NC}"
    echo ""
    read -p "  Enter email address for alerts (or press Enter to skip): " ALERT_EMAIL

    if [ -n "$ALERT_EMAIL" ]; then
        aws sns subscribe \
            --topic-arn "${SNS_TOPIC_ARN}" \
            --protocol email \
            --notification-endpoint "${ALERT_EMAIL}" \
            --region "${AWS_REGION}"

        echo -e "  ${GREEN}Subscription created. Check your email to confirm!${NC}"
    fi

    echo ""
}

# ============================================
# ECS SERVICE ALARMS
# ============================================
create_ecs_alarms() {
    echo -e "${BLUE}[2/5] Creating ECS Service Alarms...${NC}"

    for SERVICE in "${FRONTEND_SERVICE}" "${BACKEND_SERVICE}"; do
        # CPU Utilization Alarm (> 80%)
        ALARM_NAME="${PROJECT_NAME}-${SERVICE}-cpu-high"
        aws cloudwatch put-metric-alarm \
            --alarm-name "${ALARM_NAME}" \
            --alarm-description "ECS ${SERVICE} CPU utilization > 80%" \
            --metric-name CPUUtilization \
            --namespace AWS/ECS \
            --statistic Average \
            --period 300 \
            --threshold 80 \
            --comparison-operator GreaterThanThreshold \
            --dimensions "Name=ClusterName,Value=${CLUSTER_NAME}" "Name=ServiceName,Value=${SERVICE}" \
            --evaluation-periods 2 \
            --alarm-actions "${SNS_TOPIC_ARN}" \
            --ok-actions "${SNS_TOPIC_ARN}" \
            --region "${AWS_REGION}" 2>/dev/null || true

        echo -e "  ${GREEN}Created alarm: ${ALARM_NAME}${NC}"

        # Memory Utilization Alarm (> 80%)
        ALARM_NAME="${PROJECT_NAME}-${SERVICE}-memory-high"
        aws cloudwatch put-metric-alarm \
            --alarm-name "${ALARM_NAME}" \
            --alarm-description "ECS ${SERVICE} memory utilization > 80%" \
            --metric-name MemoryUtilization \
            --namespace AWS/ECS \
            --statistic Average \
            --period 300 \
            --threshold 80 \
            --comparison-operator GreaterThanThreshold \
            --dimensions "Name=ClusterName,Value=${CLUSTER_NAME}" "Name=ServiceName,Value=${SERVICE}" \
            --evaluation-periods 2 \
            --alarm-actions "${SNS_TOPIC_ARN}" \
            --ok-actions "${SNS_TOPIC_ARN}" \
            --region "${AWS_REGION}" 2>/dev/null || true

        echo -e "  ${GREEN}Created alarm: ${ALARM_NAME}${NC}"

        # Running Task Count Alarm (< 1 = service down)
        ALARM_NAME="${PROJECT_NAME}-${SERVICE}-no-tasks"
        aws cloudwatch put-metric-alarm \
            --alarm-name "${ALARM_NAME}" \
            --alarm-description "ECS ${SERVICE} has no running tasks" \
            --metric-name RunningTaskCount \
            --namespace ECS/ContainerInsights \
            --statistic Average \
            --period 60 \
            --threshold 1 \
            --comparison-operator LessThanThreshold \
            --dimensions "Name=ClusterName,Value=${CLUSTER_NAME}" "Name=ServiceName,Value=${SERVICE}" \
            --evaluation-periods 2 \
            --alarm-actions "${SNS_TOPIC_ARN}" \
            --ok-actions "${SNS_TOPIC_ARN}" \
            --treat-missing-data notBreaching \
            --region "${AWS_REGION}" 2>/dev/null || true

        echo -e "  ${GREEN}Created alarm: ${ALARM_NAME}${NC}"
    done

    echo ""
}

# ============================================
# ALB ALARMS
# ============================================
create_alb_alarms() {
    echo -e "${BLUE}[3/5] Creating ALB Alarms...${NC}"

    # Get ALB ARN suffix for CloudWatch dimensions
    ALB_ARN=$(aws elbv2 describe-load-balancers \
        --names "${ALB_NAME}" \
        --region "${AWS_REGION}" \
        --query "LoadBalancers[0].LoadBalancerArn" --output text 2>/dev/null || echo "")

    if [ -z "$ALB_ARN" ] || [ "$ALB_ARN" == "None" ]; then
        echo -e "  ${YELLOW}ALB not found. Skipping ALB alarms.${NC}"
        echo "  Run setup-ecs.sh first to create the ALB."
        echo ""
        return
    fi

    # Extract ALB ID from ARN (app/name/id format)
    ALB_SUFFIX=$(echo "${ALB_ARN}" | sed 's/.*loadbalancer\///')

    # 5xx Error Rate Alarm (> 10 in 5 minutes)
    ALARM_NAME="${PROJECT_NAME}-alb-5xx-errors"
    aws cloudwatch put-metric-alarm \
        --alarm-name "${ALARM_NAME}" \
        --alarm-description "ALB 5xx errors > 10 in 5 minutes" \
        --metric-name HTTPCode_ELB_5XX_Count \
        --namespace AWS/ApplicationELB \
        --statistic Sum \
        --period 300 \
        --threshold 10 \
        --comparison-operator GreaterThanThreshold \
        --dimensions "Name=LoadBalancer,Value=${ALB_SUFFIX}" \
        --evaluation-periods 1 \
        --alarm-actions "${SNS_TOPIC_ARN}" \
        --ok-actions "${SNS_TOPIC_ARN}" \
        --treat-missing-data notBreaching \
        --region "${AWS_REGION}" 2>/dev/null || true

    echo -e "  ${GREEN}Created alarm: ${ALARM_NAME}${NC}"

    # 4xx Error Rate Alarm (> 50 in 5 minutes)
    ALARM_NAME="${PROJECT_NAME}-alb-4xx-errors"
    aws cloudwatch put-metric-alarm \
        --alarm-name "${ALARM_NAME}" \
        --alarm-description "ALB 4xx errors > 50 in 5 minutes" \
        --metric-name HTTPCode_ELB_4XX_Count \
        --namespace AWS/ApplicationELB \
        --statistic Sum \
        --period 300 \
        --threshold 50 \
        --comparison-operator GreaterThanThreshold \
        --dimensions "Name=LoadBalancer,Value=${ALB_SUFFIX}" \
        --evaluation-periods 1 \
        --alarm-actions "${SNS_TOPIC_ARN}" \
        --treat-missing-data notBreaching \
        --region "${AWS_REGION}" 2>/dev/null || true

    echo -e "  ${GREEN}Created alarm: ${ALARM_NAME}${NC}"

    # Target Response Time Alarm (> 5 seconds average)
    ALARM_NAME="${PROJECT_NAME}-alb-latency-high"
    aws cloudwatch put-metric-alarm \
        --alarm-name "${ALARM_NAME}" \
        --alarm-description "ALB target response time > 5 seconds" \
        --metric-name TargetResponseTime \
        --namespace AWS/ApplicationELB \
        --statistic Average \
        --period 300 \
        --threshold 5 \
        --comparison-operator GreaterThanThreshold \
        --dimensions "Name=LoadBalancer,Value=${ALB_SUFFIX}" \
        --evaluation-periods 2 \
        --alarm-actions "${SNS_TOPIC_ARN}" \
        --ok-actions "${SNS_TOPIC_ARN}" \
        --treat-missing-data notBreaching \
        --region "${AWS_REGION}" 2>/dev/null || true

    echo -e "  ${GREEN}Created alarm: ${ALARM_NAME}${NC}"

    # Unhealthy Host Count Alarm
    ALARM_NAME="${PROJECT_NAME}-alb-unhealthy-hosts"
    aws cloudwatch put-metric-alarm \
        --alarm-name "${ALARM_NAME}" \
        --alarm-description "ALB has unhealthy targets" \
        --metric-name UnHealthyHostCount \
        --namespace AWS/ApplicationELB \
        --statistic Average \
        --period 60 \
        --threshold 1 \
        --comparison-operator GreaterThanOrEqualToThreshold \
        --dimensions "Name=LoadBalancer,Value=${ALB_SUFFIX}" \
        --evaluation-periods 2 \
        --alarm-actions "${SNS_TOPIC_ARN}" \
        --ok-actions "${SNS_TOPIC_ARN}" \
        --treat-missing-data notBreaching \
        --region "${AWS_REGION}" 2>/dev/null || true

    echo -e "  ${GREEN}Created alarm: ${ALARM_NAME}${NC}"

    echo ""
}

# ============================================
# RDS ALARMS
# ============================================
create_rds_alarms() {
    echo -e "${BLUE}[4/5] Creating RDS Database Alarms...${NC}"

    # Check if RDS instance exists
    if ! aws rds describe-db-instances --db-instance-identifier "${RDS_INSTANCE_ID}" --region "${AWS_REGION}" &>/dev/null; then
        echo -e "  ${YELLOW}RDS instance not found. Skipping RDS alarms.${NC}"
        echo "  Run setup-aws.sh first to create the RDS instance."
        echo ""
        return
    fi

    # CPU Utilization Alarm (> 80%)
    ALARM_NAME="${PROJECT_NAME}-rds-cpu-high"
    aws cloudwatch put-metric-alarm \
        --alarm-name "${ALARM_NAME}" \
        --alarm-description "RDS CPU utilization > 80%" \
        --metric-name CPUUtilization \
        --namespace AWS/RDS \
        --statistic Average \
        --period 300 \
        --threshold 80 \
        --comparison-operator GreaterThanThreshold \
        --dimensions "Name=DBInstanceIdentifier,Value=${RDS_INSTANCE_ID}" \
        --evaluation-periods 2 \
        --alarm-actions "${SNS_TOPIC_ARN}" \
        --ok-actions "${SNS_TOPIC_ARN}" \
        --region "${AWS_REGION}" 2>/dev/null || true

    echo -e "  ${GREEN}Created alarm: ${ALARM_NAME}${NC}"

    # Database Connections Alarm (> 50)
    ALARM_NAME="${PROJECT_NAME}-rds-connections-high"
    aws cloudwatch put-metric-alarm \
        --alarm-name "${ALARM_NAME}" \
        --alarm-description "RDS database connections > 50" \
        --metric-name DatabaseConnections \
        --namespace AWS/RDS \
        --statistic Average \
        --period 300 \
        --threshold 50 \
        --comparison-operator GreaterThanThreshold \
        --dimensions "Name=DBInstanceIdentifier,Value=${RDS_INSTANCE_ID}" \
        --evaluation-periods 2 \
        --alarm-actions "${SNS_TOPIC_ARN}" \
        --ok-actions "${SNS_TOPIC_ARN}" \
        --region "${AWS_REGION}" 2>/dev/null || true

    echo -e "  ${GREEN}Created alarm: ${ALARM_NAME}${NC}"

    # Free Storage Space Alarm (< 2GB)
    ALARM_NAME="${PROJECT_NAME}-rds-storage-low"
    aws cloudwatch put-metric-alarm \
        --alarm-name "${ALARM_NAME}" \
        --alarm-description "RDS free storage < 2GB" \
        --metric-name FreeStorageSpace \
        --namespace AWS/RDS \
        --statistic Average \
        --period 300 \
        --threshold 2000000000 \
        --comparison-operator LessThanThreshold \
        --dimensions "Name=DBInstanceIdentifier,Value=${RDS_INSTANCE_ID}" \
        --evaluation-periods 1 \
        --alarm-actions "${SNS_TOPIC_ARN}" \
        --ok-actions "${SNS_TOPIC_ARN}" \
        --region "${AWS_REGION}" 2>/dev/null || true

    echo -e "  ${GREEN}Created alarm: ${ALARM_NAME}${NC}"

    # Freeable Memory Alarm (< 100MB)
    ALARM_NAME="${PROJECT_NAME}-rds-memory-low"
    aws cloudwatch put-metric-alarm \
        --alarm-name "${ALARM_NAME}" \
        --alarm-description "RDS freeable memory < 100MB" \
        --metric-name FreeableMemory \
        --namespace AWS/RDS \
        --statistic Average \
        --period 300 \
        --threshold 100000000 \
        --comparison-operator LessThanThreshold \
        --dimensions "Name=DBInstanceIdentifier,Value=${RDS_INSTANCE_ID}" \
        --evaluation-periods 2 \
        --alarm-actions "${SNS_TOPIC_ARN}" \
        --ok-actions "${SNS_TOPIC_ARN}" \
        --region "${AWS_REGION}" 2>/dev/null || true

    echo -e "  ${GREEN}Created alarm: ${ALARM_NAME}${NC}"

    echo ""
}

# ============================================
# CLOUDWATCH DASHBOARD
# ============================================
create_dashboard() {
    echo -e "${BLUE}[5/5] Creating CloudWatch Dashboard...${NC}"

    DASHBOARD_NAME="${PROJECT_NAME}-dashboard"

    # Get ALB suffix for metrics
    ALB_ARN=$(aws elbv2 describe-load-balancers \
        --names "${ALB_NAME}" \
        --region "${AWS_REGION}" \
        --query "LoadBalancers[0].LoadBalancerArn" --output text 2>/dev/null || echo "")

    ALB_SUFFIX=""
    if [ -n "$ALB_ARN" ] && [ "$ALB_ARN" != "None" ]; then
        ALB_SUFFIX=$(echo "${ALB_ARN}" | sed 's/.*loadbalancer\///')
    fi

    # Create dashboard JSON
    DASHBOARD_BODY=$(cat <<EOF
{
    "widgets": [
        {
            "type": "text",
            "x": 0,
            "y": 0,
            "width": 24,
            "height": 1,
            "properties": {
                "markdown": "# EICR-oMatic 3000 - Production Dashboard"
            }
        },
        {
            "type": "metric",
            "x": 0,
            "y": 1,
            "width": 12,
            "height": 6,
            "properties": {
                "title": "ECS CPU Utilization",
                "view": "timeSeries",
                "stacked": false,
                "metrics": [
                    ["AWS/ECS", "CPUUtilization", "ClusterName", "${CLUSTER_NAME}", "ServiceName", "${FRONTEND_SERVICE}", {"label": "Frontend"}],
                    ["AWS/ECS", "CPUUtilization", "ClusterName", "${CLUSTER_NAME}", "ServiceName", "${BACKEND_SERVICE}", {"label": "Backend"}]
                ],
                "region": "${AWS_REGION}",
                "period": 60
            }
        },
        {
            "type": "metric",
            "x": 12,
            "y": 1,
            "width": 12,
            "height": 6,
            "properties": {
                "title": "ECS Memory Utilization",
                "view": "timeSeries",
                "stacked": false,
                "metrics": [
                    ["AWS/ECS", "MemoryUtilization", "ClusterName", "${CLUSTER_NAME}", "ServiceName", "${FRONTEND_SERVICE}", {"label": "Frontend"}],
                    ["AWS/ECS", "MemoryUtilization", "ClusterName", "${CLUSTER_NAME}", "ServiceName", "${BACKEND_SERVICE}", {"label": "Backend"}]
                ],
                "region": "${AWS_REGION}",
                "period": 60
            }
        },
        {
            "type": "metric",
            "x": 0,
            "y": 7,
            "width": 8,
            "height": 6,
            "properties": {
                "title": "ALB Request Count",
                "view": "timeSeries",
                "stacked": false,
                "metrics": [
                    ["AWS/ApplicationELB", "RequestCount", "LoadBalancer", "${ALB_SUFFIX}"]
                ],
                "region": "${AWS_REGION}",
                "period": 60,
                "stat": "Sum"
            }
        },
        {
            "type": "metric",
            "x": 8,
            "y": 7,
            "width": 8,
            "height": 6,
            "properties": {
                "title": "ALB Response Time",
                "view": "timeSeries",
                "stacked": false,
                "metrics": [
                    ["AWS/ApplicationELB", "TargetResponseTime", "LoadBalancer", "${ALB_SUFFIX}"]
                ],
                "region": "${AWS_REGION}",
                "period": 60,
                "stat": "Average"
            }
        },
        {
            "type": "metric",
            "x": 16,
            "y": 7,
            "width": 8,
            "height": 6,
            "properties": {
                "title": "ALB HTTP Errors",
                "view": "timeSeries",
                "stacked": true,
                "metrics": [
                    ["AWS/ApplicationELB", "HTTPCode_ELB_4XX_Count", "LoadBalancer", "${ALB_SUFFIX}", {"label": "4xx", "color": "#ff7f0e"}],
                    ["AWS/ApplicationELB", "HTTPCode_ELB_5XX_Count", "LoadBalancer", "${ALB_SUFFIX}", {"label": "5xx", "color": "#d62728"}]
                ],
                "region": "${AWS_REGION}",
                "period": 60,
                "stat": "Sum"
            }
        },
        {
            "type": "metric",
            "x": 0,
            "y": 13,
            "width": 8,
            "height": 6,
            "properties": {
                "title": "RDS CPU Utilization",
                "view": "timeSeries",
                "stacked": false,
                "metrics": [
                    ["AWS/RDS", "CPUUtilization", "DBInstanceIdentifier", "${RDS_INSTANCE_ID}"]
                ],
                "region": "${AWS_REGION}",
                "period": 60
            }
        },
        {
            "type": "metric",
            "x": 8,
            "y": 13,
            "width": 8,
            "height": 6,
            "properties": {
                "title": "RDS Connections",
                "view": "timeSeries",
                "stacked": false,
                "metrics": [
                    ["AWS/RDS", "DatabaseConnections", "DBInstanceIdentifier", "${RDS_INSTANCE_ID}"]
                ],
                "region": "${AWS_REGION}",
                "period": 60
            }
        },
        {
            "type": "metric",
            "x": 16,
            "y": 13,
            "width": 8,
            "height": 6,
            "properties": {
                "title": "RDS Free Storage (GB)",
                "view": "timeSeries",
                "stacked": false,
                "metrics": [
                    ["AWS/RDS", "FreeStorageSpace", "DBInstanceIdentifier", "${RDS_INSTANCE_ID}", {"label": "Free Storage"}]
                ],
                "region": "${AWS_REGION}",
                "period": 300,
                "yAxis": {
                    "left": {
                        "label": "Bytes"
                    }
                }
            }
        },
        {
            "type": "alarm",
            "x": 0,
            "y": 19,
            "width": 24,
            "height": 3,
            "properties": {
                "title": "Active Alarms",
                "alarms": [
                    "arn:aws:cloudwatch:${AWS_REGION}:${ACCOUNT_ID}:alarm:${PROJECT_NAME}-${FRONTEND_SERVICE}-cpu-high",
                    "arn:aws:cloudwatch:${AWS_REGION}:${ACCOUNT_ID}:alarm:${PROJECT_NAME}-${BACKEND_SERVICE}-cpu-high",
                    "arn:aws:cloudwatch:${AWS_REGION}:${ACCOUNT_ID}:alarm:${PROJECT_NAME}-alb-5xx-errors",
                    "arn:aws:cloudwatch:${AWS_REGION}:${ACCOUNT_ID}:alarm:${PROJECT_NAME}-rds-cpu-high",
                    "arn:aws:cloudwatch:${AWS_REGION}:${ACCOUNT_ID}:alarm:${PROJECT_NAME}-rds-storage-low"
                ]
            }
        }
    ]
}
EOF
)

    aws cloudwatch put-dashboard \
        --dashboard-name "${DASHBOARD_NAME}" \
        --dashboard-body "${DASHBOARD_BODY}" \
        --region "${AWS_REGION}"

    echo -e "  ${GREEN}Created dashboard: ${DASHBOARD_NAME}${NC}"
    echo ""
    echo "  View dashboard at:"
    echo "  https://${AWS_REGION}.console.aws.amazon.com/cloudwatch/home?region=${AWS_REGION}#dashboards:name=${DASHBOARD_NAME}"
    echo ""
}

# ============================================
# SUMMARY
# ============================================
print_summary() {
    echo ""
    echo "============================================"
    echo -e "${GREEN}Monitoring Setup Complete!${NC}"
    echo "============================================"
    echo ""
    echo "Created resources:"
    echo ""
    echo "  SNS Topic:"
    echo "    - ${SNS_TOPIC_NAME}"
    echo ""
    echo "  CloudWatch Alarms:"
    echo "    ECS Services:"
    echo "      - CPU utilization > 80%"
    echo "      - Memory utilization > 80%"
    echo "      - No running tasks"
    echo ""
    echo "    Application Load Balancer:"
    echo "      - 5xx errors > 10 in 5 min"
    echo "      - 4xx errors > 50 in 5 min"
    echo "      - Response time > 5 seconds"
    echo "      - Unhealthy targets"
    echo ""
    echo "    RDS Database:"
    echo "      - CPU utilization > 80%"
    echo "      - Database connections > 50"
    echo "      - Free storage < 2GB"
    echo "      - Freeable memory < 100MB"
    echo ""
    echo "  CloudWatch Dashboard:"
    echo "    - ${PROJECT_NAME}-dashboard"
    echo ""
    echo "============================================"
    echo "  Next Steps"
    echo "============================================"
    echo ""
    echo "1. Confirm email subscription (check inbox)"
    echo ""
    echo "2. View dashboard:"
    echo "   https://${AWS_REGION}.console.aws.amazon.com/cloudwatch/home?region=${AWS_REGION}#dashboards:name=${PROJECT_NAME}-dashboard"
    echo ""
    echo "3. View alarms:"
    echo "   https://${AWS_REGION}.console.aws.amazon.com/cloudwatch/home?region=${AWS_REGION}#alarmsV2:"
    echo ""
    echo "4. Test alerts by simulating high load or stopping a service"
    echo ""
    echo "============================================"
    echo "  Estimated Monthly Cost"
    echo "============================================"
    echo ""
    echo "  - CloudWatch Alarms: ~\$0.10/alarm/month x 14 = ~\$1.40"
    echo "  - CloudWatch Dashboard: ~\$3/month"
    echo "  - SNS Notifications: Free tier (1M requests)"
    echo ""
    echo "  Total: ~\$5/month"
    echo ""
}

# ============================================
# MAIN
# ============================================
main() {
    check_prerequisites

    echo "This script will create:"
    echo "  1. SNS topic for alert notifications"
    echo "  2. ECS service alarms (CPU, memory, task count)"
    echo "  3. ALB alarms (errors, latency, health)"
    echo "  4. RDS alarms (CPU, connections, storage)"
    echo "  5. CloudWatch dashboard"
    echo ""
    read -p "Continue? (y/n) " -n 1 -r
    echo ""

    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Aborted."
        exit 1
    fi

    create_sns_topic
    create_ecs_alarms
    create_alb_alarms
    create_rds_alarms
    create_dashboard
    print_summary
}

# Run if executed directly
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi
