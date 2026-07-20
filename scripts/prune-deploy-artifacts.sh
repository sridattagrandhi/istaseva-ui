#!/usr/bin/env bash
# Post-deploy cleanup. Runs after every `npm run deploy:<env>` so we don't
# accumulate stale Docker images locally or zombie ECS task definitions.
#
# Usage: ./scripts/prune-deploy-artifacts.sh <env>
#        env ∈ {staging, production}
#
# What this prunes:
#   1. Local cdkasset-* Docker images — keeps the 3 most recent (current
#      deploy + 2 prior, useful for emergency rollback). Older deletes save
#      ~309 MB each.
#   2. ECS task definitions — deregisters INACTIVE revisions older than 7
#      days. Doesn't recover storage but keeps the console clean.
#   3. Buildkit cache older than 24h.
#   4. Local cdk.out.
#
# What this does NOT prune (handled elsewhere):
#   - ECR images: handled by the ECR lifecycle policy (keep last 10).
#   - Running ECS service revision: never touched.
set -uo pipefail

ENV_NAME="${1:-staging}"
PROFILE="${AWS_PROFILE:-instaserve}"
REGION="${AWS_REGION:-ap-south-1}"

echo "→ Pruning local cdkasset-* images (keep 3 most recent)..."
# Pick out distinct image IDs ordered by recency, keep the 3 most recent.
# Each CDK asset is tagged twice locally — once as `cdkasset-<hash>` and
# once as `<ecr-url>:<hash>` — so we match either repo prefix and dedupe
# by image ID.
KEEP_FILE=$(mktemp)
docker images --format '{{.CreatedAt}}\t{{.ID}}\t{{.Repository}}:{{.Tag}}' \
  | grep -E "$(printf '\t')(cdkasset-|.+\\.dkr\\.ecr\\..+\\.amazonaws\\.com/cdk-)" \
  | sort -r \
  | awk -F'\t' '!seen[$2]++ {print $2}' \
  | head -3 > "$KEEP_FILE"
PRUNED=0
docker images --format '{{.ID}}\t{{.Repository}}:{{.Tag}}' \
  | grep -E "$(printf '\t')(cdkasset-|.+\\.dkr\\.ecr\\..+\\.amazonaws\\.com/cdk-)" \
  | while IFS=$'\t' read -r ID TAG; do
      if ! grep -qx "$ID" "$KEEP_FILE"; then
        if docker rmi -f "$TAG" >/dev/null 2>&1; then
          echo "  removed $TAG"
          PRUNED=$((PRUNED + 1))
        fi
      fi
    done
rm -f "$KEEP_FILE"

echo ""
echo "→ Pruning Docker buildkit cache (>24h)..."
docker builder prune -af --filter until=24h >/dev/null 2>&1 || true
docker system df 2>/dev/null | head -5

echo ""
echo "→ Deregistering INACTIVE ECS task definitions older than 7 days..."
CUTOFF=$(date -u -v-7d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '7 days ago' +%Y-%m-%dT%H:%M:%SZ)
# We iterate ALL families (without --status filter — that filters by family
# status, not revision status, and the family is ACTIVE as long as one
# revision is ACTIVE). Inside each family, we list INACTIVE revisions and
# drop ones registered before the cutoff.
for FAMILY in $(AWS_PROFILE="$PROFILE" AWS_REGION="$REGION" \
  aws ecs list-task-definition-families --family-prefix InstaServe \
  --query 'families' --output text 2>/dev/null); do
  ARNS=$(AWS_PROFILE="$PROFILE" AWS_REGION="$REGION" \
    aws ecs list-task-definitions --family-prefix "$FAMILY" --status INACTIVE \
    --query 'taskDefinitionArns' --output text)
  COUNT=0
  for ARN in $ARNS; do
    REGISTERED=$(AWS_PROFILE="$PROFILE" AWS_REGION="$REGION" \
      aws ecs describe-task-definition --task-definition "$ARN" \
      --query 'taskDefinition.registeredAt' --output text 2>/dev/null)
    if [ -n "$REGISTERED" ] && [[ "$REGISTERED" < "$CUTOFF" ]]; then
      AWS_PROFILE="$PROFILE" AWS_REGION="$REGION" \
        aws ecs deregister-task-definition --task-definition "$ARN" >/dev/null 2>&1
      COUNT=$((COUNT + 1))
    fi
  done
  [ "$COUNT" -gt 0 ] && echo "  $FAMILY: deregistered $COUNT revisions"
done

echo ""
echo "→ Removing local cdk.out..."
rm -rf "$(dirname "$0")/../infrastructure/cdk.out"

echo ""
echo "✓ Prune complete (env=$ENV_NAME)"
