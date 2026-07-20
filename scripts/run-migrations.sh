#!/usr/bin/env bash
# Runs the migration ECS task against the deployed stack and waits for it to
# finish. Reads connection details from CloudFormation outputs so it stays in
# sync with whatever the CDK stack produced.
#
# Usage:  ./scripts/run-migrations.sh <stack-name>
#   e.g.  ./scripts/run-migrations.sh InstaserveStaging
#
# Requires: aws CLI (v2), jq.
set -euo pipefail

STACK="${1:-${STACK:-}}"
if [[ -z "${STACK}" ]]; then
  echo "Usage: $0 <stack-name>" >&2
  exit 2
fi

AWS_REGION="${AWS_REGION:-ap-south-1}"

echo "→ Reading stack outputs from ${STACK} (${AWS_REGION})"
OUTPUTS_JSON=$(aws cloudformation describe-stacks \
  --region "${AWS_REGION}" \
  --stack-name "${STACK}" \
  --query 'Stacks[0].Outputs' \
  --output json)

get_output () {
  echo "${OUTPUTS_JSON}" | jq -r --arg k "$1" '.[] | select(.OutputKey==$k) | .OutputValue'
}

CLUSTER=$(get_output EcsClusterName)
TASK_DEF=$(get_output MigrationTaskDefArn)
SUBNET_CSV=$(get_output MigrationSubnetIds)
SG=$(get_output MigrationSecurityGroupId)

if [[ -z "${CLUSTER}" || -z "${TASK_DEF}" || -z "${SUBNET_CSV}" || -z "${SG}" ]]; then
  echo "ERROR: missing one of EcsClusterName / MigrationTaskDefArn / MigrationSubnetIds / MigrationSecurityGroupId in stack outputs." >&2
  exit 1
fi

SUBNETS_JSON=$(echo "${SUBNET_CSV}" | tr ',' '\n' | jq -R . | jq -s .)

echo "→ Launching migration task on cluster ${CLUSTER}"
TASK_ARN=$(aws ecs run-task \
  --region "${AWS_REGION}" \
  --cluster "${CLUSTER}" \
  --task-definition "${TASK_DEF}" \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=$(echo "${SUBNETS_JSON}" | jq -c .),securityGroups=[\"${SG}\"],assignPublicIp=DISABLED}" \
  --query 'tasks[0].taskArn' \
  --output text)

if [[ -z "${TASK_ARN}" || "${TASK_ARN}" == "None" ]]; then
  echo "ERROR: aws ecs run-task did not return a task ARN" >&2
  exit 1
fi
echo "→ Task ${TASK_ARN}; waiting for completion..."

aws ecs wait tasks-stopped \
  --region "${AWS_REGION}" \
  --cluster "${CLUSTER}" \
  --tasks "${TASK_ARN}"

EXIT_CODE=$(aws ecs describe-tasks \
  --region "${AWS_REGION}" \
  --cluster "${CLUSTER}" \
  --tasks "${TASK_ARN}" \
  --query 'tasks[0].containers[0].exitCode' \
  --output text)

REASON=$(aws ecs describe-tasks \
  --region "${AWS_REGION}" \
  --cluster "${CLUSTER}" \
  --tasks "${TASK_ARN}" \
  --query 'tasks[0].stoppedReason' \
  --output text)

echo "→ Migration task exit code: ${EXIT_CODE}"
echo "→ Stopped reason: ${REASON}"

if [[ "${EXIT_CODE}" != "0" ]]; then
  echo "ERROR: migration task failed" >&2
  exit 1
fi
echo "✓ Migrations applied"
